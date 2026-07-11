// Spawn Admin PWA service worker — minimal, install-enabling, NO caching.
// The admin dashboard is a LIVE tool that always needs the network, so caching
// the shell only causes staleness + (on flaky WAN) "loading forever" hangs.
// This SW exists ONLY to make the site installable; it never intercepts fetches
// and purges any old caches left by earlier caching versions.

self.addEventListener('install', () => {
  self.skipWaiting();               // activate immediately, don't wait
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.map((k) => caches.delete(k))))  // purge ALL old caches
      .then(() => self.clients.claim())
  );
});

// Network passthrough: a fetch handler must exist for installability, but we do
// NOT call respondWith — the browser loads every request normally (always fresh).
self.addEventListener('fetch', () => {});