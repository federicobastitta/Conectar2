// Service worker de Conectar (PWA de la agenda médica).
// Estrategia simple y segura:
//  - Navegaciones y API: siempre red primero (nunca datos viejos); si no hay
//    red, cae a la última página cacheada para que la app abra igual.
//  - Assets estáticos (js/css/imágenes con hash): cache primero.
const CACHE = "conectar-v1";

self.addEventListener("install", (event) => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  // La API nunca se cachea
  if (url.pathname.startsWith("/api")) return;

  if (req.mode === "navigate") {
    // Red primero; si falla, la última versión cacheada de la página
    event.respondWith(
      fetch(req)
        .then((res) => {
          const copia = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copia));
          return res;
        })
        .catch(() => caches.match(req).then((hit) => hit || caches.match("./")))
    );
    return;
  }

  // Assets: cache primero (Vite les pone hash, no cambian)
  if (/\.(js|css|png|jpg|jpeg|svg|webp|woff2?)$/.test(url.pathname)) {
    event.respondWith(
      caches.match(req).then(
        (hit) =>
          hit ||
          fetch(req).then((res) => {
            const copia = res.clone();
            caches.open(CACHE).then((c) => c.put(req, copia));
            return res;
          })
      )
    );
  }
});
