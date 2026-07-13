/* SpawnCloud Manager service worker — install-enabling, no caching.
   A live fleet tool always needs the network, and cached shells cause
   staleness + "loading forever" on flaky field connections. This SW
   only makes the app installable; it never intercepts fetches and
   purges any old caches from earlier versions. */

self.addEventListener('install', () => self.skipWaiting());

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// Network passthrough — fetch handler present for installability, no respondWith.
self.addEventListener('fetch', () => {});
