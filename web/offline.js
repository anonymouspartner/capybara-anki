// Offline support (step 3, docs/DESIGN.md §6) — an IndexedDB-backed queue for
// reviews submitted while offline, plus a cache of the last-fetched due queue and
// deck list so a reload while still offline shows something instead of "Loading…"
// forever. Deliberately narrow, matching §6's table: only *reviews* are queued for
// replay (client-generated `reviewId` makes a retried or double-submitted review an
// idempotent no-op server-side, per §4.2 — reviewing the same card twice during one
// offline stretch after a reload is harmless for the same reason, just two real
// events instead of one). Suspend/edit/delete are not queued — they're rarer
// mid-session actions, and failing them visibly while offline is more honest than
// queuing a delete that might race a review of the same note.

const DB_NAME = "capybara-anki";
const DB_VERSION = 1;
const PENDING_REVIEWS_STORE = "pendingReviews";
const CACHE_STORE = "cachedResponses";

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(PENDING_REVIEWS_STORE)) {
        db.createObjectStore(PENDING_REVIEWS_STORE, { keyPath: "reviewId" });
      }
      if (!db.objectStoreNames.contains(CACHE_STORE)) {
        db.createObjectStore(CACHE_STORE, { keyPath: "key" });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function runTx(db, storeName, mode, fn) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, mode);
    const store = tx.objectStore(storeName);
    const result = fn(store);
    tx.oncomplete = () => resolve(result);
    tx.onerror = () => reject(tx.error);
  });
}

/** Queues a review submitted while offline. `review` is exactly the body
 * `/sync/review` expects (`{reviewId, noteId, rating, reviewedAt}`). */
export async function queueReview(review) {
  const db = await openDb();
  await runTx(db, PENDING_REVIEWS_STORE, "readwrite", (store) => store.put(review));
}

/** Every review not yet confirmed synced, oldest first (insertion order — IndexedDB
 * cursors over a keyPath store don't guarantee this on their own, so this reads via
 * getAll and relies on `reviewedAt` for ordering instead of trusting store order). */
export async function listPendingReviews() {
  const db = await openDb();
  const all = await new Promise((resolve, reject) => {
    const req = db.transaction(PENDING_REVIEWS_STORE, "readonly")
      .objectStore(PENDING_REVIEWS_STORE)
      .getAll();
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return all.sort((a, b) => new Date(a.reviewedAt) - new Date(b.reviewedAt));
}

export async function removePendingReview(reviewId) {
  const db = await openDb();
  await runTx(db, PENDING_REVIEWS_STORE, "readwrite", (store) => store.delete(reviewId));
}

export async function pendingReviewCount() {
  return (await listPendingReviews()).length;
}

/** Caches the last good response for a GET path, keyed by the path itself
 * (including its query string, so `/sync/due?deck=Ukrainian` and `/sync/due` are
 * cached separately). Not a generic HTTP cache — just enough to redraw the last
 * known screen when a fetch fails outright. */
export async function cacheResponse(key, value) {
  const db = await openDb();
  await runTx(db, CACHE_STORE, "readwrite", (store) => store.put({ key, value }));
}

export async function getCachedResponse(key) {
  const db = await openDb();
  const row = await new Promise((resolve, reject) => {
    const req = db.transaction(CACHE_STORE, "readonly").objectStore(CACHE_STORE).get(key);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return row?.value;
}
