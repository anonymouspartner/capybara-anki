// Service worker (step 3, docs/DESIGN.md §6) — caches the static app shell so the
// page itself loads offline. Deliberately does not touch `/sync/*`: API data
// freshness/queuing is `offline.js`'s job (an explicit IndexedDB cache + review
// queue app.js reads from), not something to fake via an HTTP cache that could
// silently serve stale due-queue data as if it were current.

const CACHE_NAME = "capybara-anki-shell-v1";
const SHELL_FILES = ["/", "/index.html", "/app.js", "/offline.js"];

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
  if (url.pathname.startsWith("/sync")) return; // never intercept API calls

  event.respondWith(
    caches.match(event.request).then((cached) => cached ?? fetch(event.request)),
  );
});
