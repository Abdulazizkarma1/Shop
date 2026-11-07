/* Build replaces PRECACHE with the complete, hashed asset list. */
const CACHE = 'grainkeeper-shell-v3';
const PRECACHE = ['/', '/index.html', '/rice-sacks.svg', '/manifest.webmanifest'];
self.addEventListener('install', event => event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(PRECACHE)).then(() => self.skipWaiting())));
self.addEventListener('activate', event => event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(key => key.startsWith('grainkeeper-shell-') && key !== CACHE).map(key => caches.delete(key)))).then(() => self.clients.claim())));
self.addEventListener('fetch', event => {
  const req = event.request, url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== self.location.origin) return;
  if (req.mode === 'navigate') {
    event.respondWith(fetch(req).then(async response => {
      if (response.ok && response.headers.get('content-type')?.includes('text/html')) {
        const cache = await caches.open(CACHE); await cache.put('/index.html', response.clone());
      }
      return response;
    }).catch(() => caches.match('/index.html')));
  } else if (PRECACHE.includes(url.pathname)) {
    event.respondWith(caches.match(req).then(cached => cached || fetch(req)));
  }
});
