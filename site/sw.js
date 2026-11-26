// Sésame — service worker : rend l'appli installable et la charge vite.
// Les vérifications (QR, PIN) passent toujours par internet : rien n'est mis en cache côté données.
const CACHE = "sesame-v10";
const SHELL = [
  "./", "index.html", "style.css", "common.js", "app.js", "config.js", "admin.html", "admin.js", "demo-server.js", "demo.html",
  "vendor/qrcode.js", "vendor/jsQR.js", "manifest.webmanifest",
  "icons/icon-192.png", "icons/icon-512.png"
];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.origin !== self.location.origin) return;
  // Réseau d'abord (toujours la dernière version), cache seulement si hors ligne.
  e.respondWith(
    fetch(e.request)
      .then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(e.request, copy));
        return res;
      })
      .catch(() => caches.match(e.request).then((r) => r || caches.match("index.html")))
  );
});
