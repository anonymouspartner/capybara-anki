// Service worker (step 3, docs/DESIGN.md §6) — caches the static app shell so the
// page itself loads offline. Deliberately does not touch `/sync/*`: API data
// freshness/queuing is `offline.js`'s job (an explicit IndexedDB cache + review
// queue app.js reads from), not something to fake via an HTTP cache that could
// silently serve stale due-queue data as if it were current.

const CACHE_NAME = "capybara-anki-shell-v6";
// Hosted on GitHub Pages (a project site: https://<owner>.github.io/<repo>/,
// not domain root) — these are resolved against sw.js's own URL at runtime,
// not hardcoded, so the shell caches correctly regardless of the subpath (or
// a future custom domain) it's actually served from.
const SHELL_FILE_NAMES = [
  "./",
  "index.html",
  "app.js",
  "config.js",
  "offline.js",
  "auth.js",
  "telegram.js",
  "theme.css",
  "scan.html",
  "scan.js",
  "stats.html",
  "stats.js",
];
const SHELL_FILES = SHELL_FILE_NAMES.map((name) => new URL(name, self.location).href);

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
  // Never intercept API calls — sync/scan/pronounce now live on a different
  // origin entirely (Supabase, not this GitHub Pages site), and a cache-first
  // match against a POST it never cached would only paper over a real network
  // failure rather than fail honestly. Checking origin rather than a specific
  // path prefix is what makes that true regardless of which Supabase project
  // (i.e. which couple's instance) this happens to be.
  if (url.origin !== self.location.origin) return;

  event.respondWith(
    caches.match(event.request).then((cached) => cached ?? fetch(event.request)),
  );
});
