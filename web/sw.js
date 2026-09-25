// Service worker (step 3, docs/DESIGN.md §6) — caches the static app shell so the
// page itself loads offline. Deliberately does not touch `/sync/*`: API data
// freshness/queuing is `offline.js`'s job (an explicit IndexedDB cache + review
// queue app.js reads from), not something to fake via an HTTP cache that could
// silently serve stale due-queue data as if it were current.
//
// Phase 5.4 adds a second cache, for pronunciation reference audio (D18/D23) —
// public-read files in Supabase Storage, a different origin from this GitHub
// Pages shell but static content, not API data, so cache-first is the right
// policy (unlike /sync/*). MIGRATION.md §4 measured the real set at 190 files,
// 14.3 MB total: small enough to cache all of it, unconditionally, rather than
// trying to guess which cards someone will hit offline. `app.js` fetches the
// current list from `/sync/audio-manifest` once per load and posts it here
// (the 'message' handler below) rather than this file querying the API
// itself — a service worker has no `Authorization` header to send, and the
// page already has one.

const CACHE_NAME = "capybara-anki-shell-v10";
const AUDIO_CACHE_NAME = "capybara-anki-audio-v1";
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
      .then((keys) =>
        Promise.all(keys.filter((k) => k !== CACHE_NAME && k !== AUDIO_CACHE_NAME).map((k) => caches.delete(k)))
      )
      .then(() => self.clients.claim()),
  );
});

// A GET's own path is enough to tell Storage's public-read audio objects
// apart from everything else Supabase serves (the /sync, /scan, /pronounce
// Edge Functions this file must never cache-match — see the fetch handler's
// own comment) — confirmed against the real upload path
// (migration/upload_pronunciation_audio.py's BUCKET/public URL shape), not
// guessed. `pathname.includes` rather than `startsWith`, since the Supabase
// project id lives earlier in the same origin's path structure than this
// check needs to know about.
function isPronunciationAudio(url) {
  return url.pathname.includes("/storage/v1/object/public/");
}

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);

  if (url.origin !== self.location.origin) {
    // Everything else cross-origin is an API call (sync/scan/pronounce) and
    // must never be cache-matched — a cache-first match against a POST it
    // never cached would only paper over a real network failure rather than
    // fail honestly. Reference audio is the one deliberate exception: a
    // static file, not API data, so cache-first is exactly the right policy,
    // served from AUDIO_CACHE_NAME once the 'message' handler below has
    // fetched it, falling through to the network otherwise (first load,
    // before Phase 5.4's caching pass has run, or a note added since).
    if (isPronunciationAudio(url)) {
      event.respondWith(caches.match(event.request).then((cached) => cached ?? fetch(event.request)));
    }
    return;
  }

  event.respondWith(
    caches.match(event.request).then((cached) => cached ?? fetch(event.request)),
  );
});

// `app.js` posts { type: 'cache-audio', urls } once per page load, after
// asking /sync/audio-manifest for the current list. Skips whatever's already
// cached rather than re-fetching all 190 files every time — the manifest is
// the same list far more often than it isn't, and Cache Storage doesn't tell
// you what changed, only what's there now. `Promise.allSettled`, not
// `Promise.all`: one dead link (a note whose audio_url outran an actual
// upload) must not stop the other 189 from caching.
self.addEventListener("message", (event) => {
  if (event.data?.type !== "cache-audio") return;
  const urls = event.data.urls ?? [];
  event.waitUntil(
    caches.open(AUDIO_CACHE_NAME).then(async (cache) => {
      const missing = [];
      for (const url of urls) {
        if (!(await cache.match(url))) missing.push(url);
      }
      await Promise.allSettled(
        missing.map((url) => fetch(url).then((res) => (res.ok ? cache.put(url, res) : undefined))),
      );
    }),
  );
});
