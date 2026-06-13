// sw.js — caches the app shell so it works offline once loaded.
const CACHE = 'calorie-tracker-v35';
const ASSETS = [
  './',
  './index.html',
  './manifest.webmanifest',
  './css/styles.css',
  './js/app.js',
  './js/db.js',
  './js/charts.js',
  './js/off.js',
  './js/zxing.js',
  './icons/icon.svg',
  './icons/apple-icon-192.png',
  './icons/apple-icon-512.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// Cache-first for app assets; network fallback. Data lives in IndexedDB, not here.
self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;
  // Let cross-origin calls (e.g. Open Food Facts API) go straight to the network.
  if (new URL(e.request.url).origin !== self.location.origin) return;
  e.respondWith(
    caches.match(e.request).then(cached => cached || fetch(e.request).then(res => {
      const copy = res.clone();
      caches.open(CACHE).then(c => c.put(e.request, copy)).catch(() => {});
      return res;
    }).catch(() => cached))
  );
});
