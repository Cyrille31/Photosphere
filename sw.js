// Service worker : fonctionnement hors connexion (réseau d'abord, cache en secours).
const CACHE = 'photosphere-v1';
const FILES = [
  './', 'index.html', 'app.css', 'player.css', 'manifest.webmanifest',
  'assets/logo.svg', 'assets/icon-192.png', 'assets/icon-512.png', 'assets/icon-maskable-512.png',
  'src/app.js', 'src/ui.js', 'src/db.js', 'src/editor.js', 'src/importer.js', 'src/exporter.js',
  'src/jpeg-encoder.js', 'src/jpeg-worker.js', 'src/metadata.js', 'src/zip.js', 'src/tour-export.js',
  'src/math.js', 'src/shaders.js', 'src/gl-source.js', 'src/renderer.js', 'src/controls.js', 'src/player.js',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(FILES)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== location.origin) return;
  e.respondWith(
    fetch(req)
      .then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy));
        }
        return res;
      })
      .catch(() => caches.match(req, { ignoreSearch: true }).then((r) => r || caches.match('index.html')))
  );
});
