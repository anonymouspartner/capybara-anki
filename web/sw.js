// Service worker (step 3, docs/DESIGN.md §6) — caches the static app shell so the
// page itself loads offline. Deliberately does not touch `/sync/*`: API data
// freshness/queuing is `offline.js`'s job (an explicit IndexedDB cache + review
// queue app.js reads from), not something to fake via an HTTP cache that could
// silently serve stale due-queue data as if it were current.

const CACHE_NAME = "capybara-anki-shell-v3";
const SHELL_FILES = [
  "/",
  "/index.html",
  "/app.js",
  "/offline.js",
  "/auth.js",
  "/theme.css",
  "/scan.html",
  "/scan.js",
  "/stats.html",
  "/stats.js",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL_FILES)).then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  // Never intercept API calls — /scan (the Claude call, step 5) needs network as
  // much as /sync does, and a cache-first match against a POST it never cached
  // would only paper over that rather than fail honestly.
  if (url.pathname.startsWith("/sync") || url.pathname.startsWith("/scan")) return;

  event.respondWith(
    caches.match(event.request).then((cached) => cached ?? fetch(event.request)),
  );
});
