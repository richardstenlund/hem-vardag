const cacheName = 'hem-vardag-v3';
const appShell = ['/', '/vardag.html', '/vardag.css', '/vardag.js', '/manifest.webmanifest'];
self.addEventListener('install', event => {
  event.waitUntil(caches.open(cacheName).then(cache => cache.addAll(appShell.map(url => new Request(url, { cache: 'reload' })))));
  self.skipWaiting();
});
self.addEventListener('activate', event => {
  event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(key => key.startsWith('hem-vardag-') && key !== cacheName).map(key => caches.delete(key)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET' || url.origin !== self.location.origin || url.pathname.startsWith('/api/')) return;
  if (!appShell.includes(url.pathname)) return;
  event.respondWith(fetch(event.request, { cache: 'no-cache' }).catch(() => caches.match(event.request)));
});
