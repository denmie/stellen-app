// Hält nur die App-Dateien offline bereit. Stellendaten und Schlüssel laufen nie hier durch.
const CACHE = 'app-v2';
const DATEIEN = ['./', 'index.html', 'app.js', 'style.css', 'manifest.webmanifest', 'icon-192.png', 'icon-512.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(DATEIEN)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((namen) => Promise.all(namen.filter((n) => n !== CACHE).map((n) => caches.delete(n))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== self.location.origin) return;
  // Netz zuerst, damit App-Änderungen ankommen. Ohne Netz aus dem Speicher.
  e.respondWith(
    fetch(e.request)
      .then((antwort) => {
        const kopie = antwort.clone();
        if (antwort.ok) caches.open(CACHE).then((c) => c.put(e.request, kopie));
        return antwort;
      })
      .catch(() => caches.match(e.request)),
  );
});
