/* EventHub Lite - Service Worker: network-first con fallback cache (statici) */
const CACHE = 'eventhub-v2';
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(clients.claim()));
self.addEventListener('fetch', (e) => {
  const u = new URL(e.request.url);
  if (u.origin !== location.origin) return;          // CDN/gist/streaming: mai cache
  if (e.request.method !== 'GET') return;
  if (u.pathname.includes('/apk/')) return;          // apk mai in cache
  e.respondWith(
    caches.open(CACHE).then(async (c) => {
      const cached = await c.match(e.request, { ignoreSearch: true });
      const fetchP = fetch(e.request).then((res) => {
        if (res && res.ok) c.put(e.request, res.clone());
        return res;
      }).catch(() => cached);
      return cached || fetchP;
    })
  );
});
