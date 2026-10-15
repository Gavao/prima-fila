// Service worker: l'app si apre anche senza rete; le locandine già viste restano salvate.
const SHELL = 'shell-v1';
const IMAGES = 'images-v1';
const FILES = [
  './', 'index.html', 'css/style.css', 'manifest.webmanifest',
  'js/app.js', 'js/db.js', 'js/tmdb.js', 'js/charts.js', 'js/version.js',
  'icons/icon-192.png', 'icons/icon-512.png', 'icons/tmdb.svg',
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(SHELL).then(c => c.addAll(FILES)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));

self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  const url = new URL(e.request.url);

  // Locandine e loghi del catalogo: non cambiano, quindi prima la copia salvata.
  if (url.hostname === 'image.tmdb.org') {
    e.respondWith(caches.open(IMAGES).then(async cache => {
      const hit = await cache.match(e.request);
      if (hit) return hit;
      const res = await fetch(e.request);
      if (res.ok || res.type === 'opaque') cache.put(e.request, res.clone());
      return res;
    }));
    return;
  }
  if (url.origin !== location.origin) return;   // catalogo e GitHub passano diretti (cache in IndexedDB)

  // File dell'app: prima la rete (così le modifiche si vedono subito), poi la copia salvata.
  e.respondWith(
    fetch(url.href, { cache: 'no-cache', credentials: 'same-origin' }).then(res => {
      if (res.ok) caches.open(SHELL).then(c => c.put(e.request, res.clone()));
      return res.clone();
    }).catch(() => caches.match(e.request, { ignoreSearch: true }))
  );
});
