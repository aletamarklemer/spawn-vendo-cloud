// Spawn Admin PWA service worker — minimal, install-enabling.
// Network-first para sa live data (dashboard kay real-time), cache ra ang app shell.
const CACHE = 'spawn-admin-v1';
const SHELL = ['/admin', '/css/app.css', '/js/api.js', '/js/admin.js', '/manifest.json'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).catch(() => {}));
  self.skipWaiting();
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) =>
    Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))));
  self.clients.claim();
});
self.addEventListener('fetch', (e) => {
  const req = e.request;
  // API calls: ALWAYS network (never cache live data), no offline fallback
  if (req.url.includes('/api/')) return;
  // App shell / static: network-first, fallback to cache kung offline
  if (req.method !== 'GET') return;
  e.respondWith(
    fetch(req).then((res) => {
      const copy = res.clone();
      caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
      return res;
    }).catch(() => caches.match(req))
  );
});