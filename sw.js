// Service worker : coquille de l'app en cache, données toujours depuis le réseau.
const VERSION = 'apluie-v1';
const SHELL = [
  './', 'index.html', 'css/app.css', 'js/app.js', 'js/api.js', 'js/stats.js', 'js/charts.js', 'js/map.js',
  'manifest.webmanifest', 'icons/icon.svg', 'icons/icon-192.png',
  'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.css',
  'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.js',
  'https://cdnjs.cloudflare.com/ajax/libs/Chart.js/4.4.1/chart.umd.min.js',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== VERSION).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  const isShell = url.origin === location.origin || url.hostname === 'cdnjs.cloudflare.com';
  if (e.request.method !== 'GET' || !isShell) return; // API et tuiles : réseau direct
  // Réseau d'abord (mises à jour immédiates), cache en secours.
  e.respondWith(fetch(e.request).then((r) => {
    if (r.ok) { const copy = r.clone(); caches.open(VERSION).then((c) => c.put(e.request, copy)); }
    return r;
  }).catch(() => caches.match(e.request, { ignoreSearch: true })));
});
