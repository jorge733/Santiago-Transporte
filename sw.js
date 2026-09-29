// Service worker: la app funciona sin conexión mostrando los últimos datos guardados.
// Cambia VERSION cada vez que modifiques index.html, styles.css o app.js.
const VERSION = 'v2';
const SHELL = `shell-${VERSION}`;
const RUNTIME = 'runtime';

const SHELL_FILES = [
  '/',
  '/index.html',
  '/styles.css',
  '/app.js',
  '/manifest.webmanifest',
  '/icons/icon.svg',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(SHELL).then((c) => c.addAll(SHELL_FILES)));
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== SHELL && k !== RUNTIME).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);

  // Datos en tiempo real: siempre red; si no hay conexión, lo último guardado.
  if (url.origin === location.origin && url.pathname.startsWith('/api/')) {
    event.respondWith(networkFirst(request));
    return;
  }

  // Datos GTFS y Leaflet: responde con caché y actualiza en segundo plano.
  if ((url.origin === location.origin && url.pathname.startsWith('/data/')) || url.hostname === 'unpkg.com') {
    event.respondWith(staleWhileRevalidate(request));
    return;
  }

  // Resto de la app: caché primero.
  if (url.origin === location.origin) {
    event.respondWith(
      caches.match(request, { ignoreSearch: true }).then((hit) => hit || fetch(request).catch(() => caches.match('/index.html'))),
    );
  }
});

async function networkFirst(request) {
  const cache = await caches.open(RUNTIME);
  try {
    const res = await fetch(request);
    if (res.ok) cache.put(request, res.clone());
    return res;
  } catch (err) {
    const hit = await cache.match(request);
    if (hit) return hit;
    throw err;
  }
}

async function staleWhileRevalidate(request) {
  const cache = await caches.open(RUNTIME);
  const hit = await cache.match(request);
  const update = fetch(request)
    .then((res) => {
      if (res.ok) cache.put(request, res.clone());
      return res;
    })
    .catch(() => hit);
  return hit || update;
}
