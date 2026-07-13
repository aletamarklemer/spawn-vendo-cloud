/* SpawnCloud Manager — API client.
   Talks to the existing Spawn Vendo backend on Railway (same one the
   admin dashboard uses). Token stored in memory + sessionStorage so a
   refresh keeps the lineman logged in for the shift. */

const API_BASE = 'https://spawn-vendo-cloud-production-4f63.up.railway.app/api';

const Auth = {
  get token() { return sessionStorage.getItem('scm_token') || null; },
  set token(v) { v ? sessionStorage.setItem('scm_token', v) : sessionStorage.removeItem('scm_token'); },
  get user() { try { return JSON.parse(sessionStorage.getItem('scm_user') || 'null'); } catch { return null; } },
  set user(v) { v ? sessionStorage.setItem('scm_user', JSON.stringify(v)) : sessionStorage.removeItem('scm_user'); },
  clear() { this.token = null; this.user = null; },
};

async function apiFetch(method, path, body) {
  const headers = { 'Content-Type': 'application/json' };
  if (Auth.token) headers['Authorization'] = 'Bearer ' + Auth.token;

  let res;
  try {
    res = await fetch(API_BASE + path, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch (e) {
    throw new Error('Network error — check your connection.');
  }

  let data = null;
  const text = await res.text();
  if (text) { try { data = JSON.parse(text); } catch { data = { raw: text }; } }

  if (!res.ok) {
    if (res.status === 401) { Auth.clear(); }
    const msg = (data && (data.error || data.message)) || `Request failed (${res.status})`;
    const err = new Error(msg);
    err.status = res.status;
    throw err;
  }
  // Backend wraps success as { success, data } in most routes; unwrap when present.
  return (data && data.data !== undefined) ? data.data : data;
}

const API = {
  get:   (p)    => apiFetch('GET', p),
  post:  (p, b) => apiFetch('POST', p, b),
  put:   (p, b) => apiFetch('PUT', p, b),
  patch: (p, b) => apiFetch('PATCH', p, b),
  del:   (p)    => apiFetch('DELETE', p),
};
