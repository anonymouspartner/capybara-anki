// Service worker (step 3, docs/DESIGN.md §6) — caches the static app shell so the
// page itself loads offline. Deliberately does not touch `/sync/*`: API data
// freshness/queuing is `offline.js`'s job (an explicit IndexedDB cache + review
// queue app.js reads from), not something to fake via an HTTP cache that could
// silently serve stale due-queue data as if it were current.

const CACHE_NAME = "capybara-anki-shell-v4";
// Served BY a Supabase Edge Function (`app`) — every real path lives under
// /functions/v1/app/, never bare root (see app.js's own comment on this). These
// are absolute from origin root, not relative to sw.js's own scope, because
// that's what `cache.addAll` needs regardless of where this file itself sits.
const SHELL_FILES = [
  "/functions/v1/app/",
  "/functions/v1/app/index.html",
  "/functions/v1/app/app.js",
  "/functions/v1/app/offline.js",
  "/functions/v1/app/auth.js",
  "/functions/v1/app/theme.css",
  "/functions/v1/app/scan.html",
  "/functions/v1/app/scan.js",
  "/functions/v1/app/stats.html",
  "/functions/v1/app/stats.js",
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
  // Never intercept API calls — /scan (the Claude call) and /pronounce (the
  // Whisper call, D18) need network as much as /sync does, and a cache-first
  // match against a POST it never cached would only paper over that rather than
  // fail honestly.
  if (
    url.pathname.startsWith("/functions/v1/sync") || url.pathname.startsWith("/functions/v1/scan") ||
    url.pathname.startsWith("/functions/v1/pronounce")
  ) return;

  event.respondWith(
    caches.match(event.request).then((cached) => cached ?? fetch(event.request)),
  );
});
