/* Sofabet service worker: app shell cache-first, /api GETs network-first. */
const CACHE = "sofabet-shell-v10";
const SHELL = [
  "/",
  "/index.html",
  "/app.js",
  "/styles.css",
  "/manifest.webmanifest",
  "/favicon.svg",
  "/icons/icon-192.png",
  "/icons/icon-512.png",
  "/fonts/fira-sans-400.woff2",
  "/fonts/fira-sans-500.woff2",
  "/fonts/fira-sans-600.woff2",
  "/fonts/fira-sans-700.woff2",
  "/fonts/fira-code-400.woff2",
  "/fonts/fira-code-500.woff2",
  "/fonts/fira-code-600.woff2",
  "/fonts/fira-code-700.woff2",
  "/fonts/space-grotesk-500.woff2",
  "/fonts/space-grotesk-700.woff2",
];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return; // never intercept writes
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  if (url.pathname.startsWith("/api/")) {
    // Network-first with cache fallback for read-only API calls.
    event.respondWith(
      fetch(request)
        .then((res) => {
          if (res.ok) {
            const clone = res.clone();
            caches.open(CACHE).then((cache) => cache.put(request, clone));
          }
          return res;
        })
        .catch(() =>
          caches.match(request).then((cached) => cached || Response.json({ error: "offline" }, { status: 503 })),
        ),
    );
    return;
  }

  // App shell: cache-first.
  event.respondWith(
    caches.match(request).then(
      (cached) =>
        cached ||
        fetch(request).then((res) => {
          if (res.ok) {
            const clone = res.clone();
            caches.open(CACHE).then((cache) => cache.put(request, clone));
          }
          return res;
        }),
    ),
  );
});
