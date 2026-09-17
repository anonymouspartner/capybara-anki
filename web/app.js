// The reviewer — step 2 of docs/DESIGN.md's build order, redesigned to match
// AnkiDroid's own layout and dark theme after seeing real screenshots of it (deck
// list with new/learning/review counts, the stats strip, card front/back
// hierarchy, the four-button rating bar). Still deliberately plain JS, no build
// step: every scheduling decision lives server-side (src/review/), so this file's
// job is fetch → render → post an answer → next card.
//
// Every deck a note actually exists in shows up here — there's no hardcoded deck
// list. Grammar is just vocabulary notes in a differently-named deck (confirmed
// against a real export, docs/DESIGN.md D17/§11 item 4) and needs nothing special.
// Pronunciation notes (D18) share the same `notes` row shape too, just with
// `kind: "pronunciation"` and a different reveal-and-rate UI (renderReview()
// branches on it below) — recording and scoring an attempt instead of a
// self-graded four-button tap. Spelling (D17's `card_kind`) surfaces as a second
// due item alongside a `Capybara+` note's normal recall card, not a separate deck.
//
// Auth (D13, §4.5): install is opening one link, `#t=<token>`. `auth.js` (shared
// with scan.js) reads the fragment, stores the token, and strips it from the
// visible URL and history so it never lingers there or gets shared by accident —
// this file just sends it as a bearer token on every call.
//
// Offline (step 3, §6): `offline.js` is the IndexedDB-backed review queue and
// response cache; `api()` below is the one place that decides when to fall back to
// it, so every call site (submitRating, refreshStatsStrip, enterDeck, …) stays
// offline-safe automatically rather than each needing its own try/catch.

import * as offline from "./offline.js";
import { captureTokenFromUrl, getToken } from "./auth.js";
import { API_BASE } from "./config.js";

async function api(path, options = {}) {
  const token = getToken();
  const method = options.method ?? "GET";
  try {
    const res = await fetch(API_BASE + path, {
      ...options,
      headers: {
        "content-type": "application/json",
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...options.headers,
      },
    });
    if (!res.ok && res.status !== 400) {
      throw new Error(`${method} ${path} -> ${res.status}`);
    }
    const data = await res.json();
    if (method === "GET") await offline.cacheResponse(path, data);
    return data;
  } catch (e) {
    // A TypeError here is fetch itself failing (no network) — distinct from a real
    // non-2xx response above, which propagates as-is (saveEdit()'s error-message
    // path depends on that). Offline, a queued review or a cached GET keeps the
    // session going instead of surfacing an error for something §6 says shouldn't
    // interrupt a review session.
    if (e instanceof TypeError) {
      if (method === "POST" && path === "/sync/review") {
        await offline.queueReview(JSON.parse(options.body));
        return { ok: true, queued: true };
      }
      if (method === "GET") {
        const cached = await offline.getCachedResponse(path);
        if (cached !== undefined) return cached;
      }
    }
    throw e;
  }
}

const contentEl = document.getElementById("content");
const titleEl = document.getElementById("title");
const backBtn = document.getElementById("back-btn");
const scanLink = document.getElementById("scan-link");
const statsStrip = document.getElementById("stats-strip");

const state = {
  view: "decks", // "decks" | "review"
  decks: [],
  currentDeck: null,
  queue: [],
  index: 0,
  revealed: false,
  editing: false,
  sessionCount: 0,
  // D18 (pronunciation notes): "idle" | "recording" | "scoring" | "scored".
  recording: "idle",
  pronunciationResult: null, // { transcript, similarity, bucket, rating } | { error } | null
};

/** Formats a due date as AnkiDroid's own short interval label ("<1m", "10m", "4d",
 * "3.2mo") — relative to now, since that's what the button is telling the person:
 * how long until this comes back if they tap it. */
function formatInterval(dueIso, now) {
  const ms = new Date(dueIso).getTime() - now.getTime();
  const minutes = ms / 60_000;
  if (minutes < 1) return "<1m";
  if (minutes < 60) return `${Math.round(minutes)}m`;
  const hours = minutes / 60;
  if (hours < 24) return `${Math.round(hours)}h`;
  const days = hours / 24;
  if (days < 30) return `${Math.round(days)}d`;
  const months = days / 30;
  if (months < 12) return `${months.toFixed(1)}mo`;
  return `${(days / 365).toFixed(1)}y`;
}

function escapeHtml(s) {
  return (s ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

backBtn.addEventListener("click", showDeckList);

// ---------------------------------------------------------------------------
// Deck list
// ---------------------------------------------------------------------------

async function showDeckList() {
  state.view = "decks";
  backBtn.hidden = true;
  scanLink.hidden = false;
  titleEl.textContent = "Capybara";
  statsStrip.hidden = true;

  contentEl.innerHTML = `<div style="padding: 40px; text-align: center; color: var(--fg-muted)">Loading…</div>`;
  try {
    state.decks = await api("/sync/decks");
  } catch (e) {
    contentEl.innerHTML = `<div id="error">Couldn't load decks.</div>`;
    console.error(e);
    return;
  }
  renderDeckList();
}

function renderDeckList() {
  const totalDue = state.decks.reduce((sum, d) => sum + d.newCount + d.learningCount + d.reviewCount, 0);
  titleEl.textContent = `Capybara — ${totalDue} due`;

  contentEl.innerHTML = `
    ${
      state.decks.map((d) => `
        <div class="deck-row" data-deck="${escapeHtml(d.deck)}">
          <span class="deck-name">${escapeHtml(d.deck)}</span>
          <span class="deck-counts">
            <span class="new">${d.newCount}</span>
            <span class="learning">${d.learningCount}</span>
            <span class="review">${d.reviewCount}</span>
          </span>
        </div>
      `).join("")
    }
    <div id="session-footer">
      Studied ${state.sessionCount} card${state.sessionCount === 1 ? "" : "s"} this session
      · <a href="./stats.html">Stats</a>
    </div>
  `;
  contentEl.querySelectorAll(".deck-row").forEach((row) => {
    row.addEventListener("click", () => enterDeck(row.dataset.deck));
  });
}

// ---------------------------------------------------------------------------
// Review
// ---------------------------------------------------------------------------

async function enterDeck(deck) {
  state.view = "review";
  state.currentDeck = deck;
  state.index = 0;
  state.revealed = false;
  state.editing = false;
  backBtn.hidden = false;
  scanLink.hidden = true;
  titleEl.textContent = deck;

  contentEl.innerHTML = `<div style="padding: 40px; text-align: center; color: var(--fg-muted)">Loading…</div>`;
  try {
    state.queue = await api(`/sync/due?deck=${encodeURIComponent(deck)}`);
  } catch (e) {
    contentEl.innerHTML = `<div id="error">Couldn't load this deck.</div>`;
    console.error(e);
    return;
  }
  await updateStatsStrip();
  renderReview();
}

function currentNote() {
  return state.queue[state.index] ?? null;
}

async function updateStatsStrip() {
  const deckSummary = state.decks.find((d) => d.deck === state.currentDeck);
  if (!deckSummary) {
    statsStrip.hidden = true;
    return;
  }
  const pending = await offline.pendingReviewCount();
  statsStrip.hidden = false;
  statsStrip.innerHTML = `
    <span class="new">${deckSummary.newCount}</span>
    <span class="learning">${deckSummary.learningCount}</span>
    <span class="review">${deckSummary.reviewCount}</span>
    ${pending > 0 ? `<span class="pending">⟳ ${pending}</span>` : ""}
  `;
}

/** Refreshes the stats strip from the server after an answer — matching real
 * Anki's live countdown, but by asking rather than guessing. An earlier version
 * of this tried to derive "was this card new or review" client-side from queue
 * position; that's exactly the kind of scheduling classification src/review/
 * already does correctly and the client has no business re-deriving badly.
 * Offline, `api()` falls back to the last cached `/sync/decks` response, so this
 * still renders something rather than throwing mid-session. */
async function refreshStatsStrip() {
  state.decks = await api("/sync/decks");
  await updateStatsStrip();
}

/** Pushes every locally-queued review to the server, oldest first, stopping at the
 * first failure (still offline, or a genuine server error) rather than reordering
 * around it — §6's "reconnect" row: the queue flushes as a batch, and a
 * client-generated `reviewId` (already required by `/sync/review`) makes a review
 * that already landed on a previous attempt a no-op instead of a duplicate. */
async function flushPendingReviews() {
  const pending = await offline.listPendingReviews();
  for (const review of pending) {
    const token = getToken();
    if (!token) return;
    let res;
    try {
      res = await fetch(API_BASE + "/sync/review", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
        body: JSON.stringify(review),
      });
    } catch {
      return; // still offline — try again on the next 'online' event
    }
    if (!res.ok) return; // a real server error; stop rather than lose ordering
    await offline.removePendingReview(review.reviewId);
  }
  if (state.view === "review") await refreshStatsStrip();
  else if (state.view === "decks") await showDeckList();
}

globalThis.addEventListener("online", flushPendingReviews);

function renderReview() {
  const note = currentNote();
  if (!note) {
    contentEl.innerHTML = `<div id="empty">Nothing due in ${escapeHtml(state.currentDeck)} right now. 🎉</div>`;
    return;
  }

  if (state.editing) {
    renderEditForm(note);
    return;
  }

  if (note.kind === "pronunciation") {
    renderPronunciationReview(note);
    return;
  }

  contentEl.innerHTML = `
    <div id="card">
      ${note.cardKind === "spelling" ? `<div class="card-kind-badge">Spelling</div>` : ""}
      <div id="lemma">${escapeHtml(note.lemma)}</div>
      <div id="back" class="${state.revealed ? "visible" : ""}">
        <hr class="divider" />
        <div class="translation">${escapeHtml(note.lemmaTranslation)}</div>
        <div class="gloss">${escapeHtml(note.gloss)}</div>
        <div class="pos">${[note.partOfSpeech, note.language].filter(Boolean).join(" · ")}</div>
        <hr class="divider" />
        ${note.example ? `<div class="example">${escapeHtml(note.example)}</div>` : ""}
        ${note.exampleTranslation ? `<div class="example-translation">${escapeHtml(note.exampleTranslation)}</div>` : ""}
      </div>
      <div id="tools-row">
        <button id="edit">Edit</button>
        <button id="suspend">Suspend</button>
        <button id="delete">Delete</button>
      </div>
    </div>
    <div id="answer-bar">
      ${
        state.revealed
          ? (() => {
              const now = new Date();
              const p = note.preview;
              return `<div id="rating-row">
               <button class="rating-again" data-rating="1"><span class="interval">${formatInterval(p.again, now)}</span><span>Again</span></button>
               <button class="rating-hard" data-rating="2"><span class="interval">${formatInterval(p.hard, now)}</span><span>Hard</span></button>
               <button class="rating-good" data-rating="3"><span class="interval">${formatInterval(p.good, now)}</span><span>Good</span></button>
               <button class="rating-easy" data-rating="4"><span class="interval">${formatInterval(p.easy, now)}</span><span>Easy</span></button>
             </div>`;
            })()
          : `<button id="reveal-btn">Show answer</button>`
      }
    </div>
  `;

  document.getElementById("reveal-btn")?.addEventListener("click", () => {
    state.revealed = true;
    renderReview();
  });
  contentEl.querySelectorAll("[data-rating]").forEach((btn) => {
    btn.addEventListener("click", () => submitRating(Number(btn.dataset.rating)));
  });
  document.getElementById("edit").addEventListener("click", () => {
    state.editing = true;
    renderReview();
  });
  document.getElementById("suspend").addEventListener("click", suspendCurrent);
  document.getElementById("delete").addEventListener("click", deleteCurrent);
}

function renderEditForm(note) {
  const fields = [
    ["lemma", "Lemma"],
    ["gloss", "Gloss"],
    ["lemmaTranslation", "Translation"],
    ["partOfSpeech", "Part of speech"],
    ["example", "Example"],
    ["exampleTranslation", "Example translation"],
  ];
  contentEl.innerHTML = `
    <div id="edit-form" class="visible">
      ${
        fields.map(([key, label]) => `
          <label>${label}
            <input data-field="${key}" value="${escapeHtml(note[key])}" />
          </label>
        `).join("")
      }
      <div id="edit-errors"></div>
      <div id="tools-row">
        <button id="save">Save</button>
        <button id="cancel">Cancel</button>
      </div>
    </div>
  `;
  document.getElementById("cancel").addEventListener("click", () => {
    state.editing = false;
    renderReview();
  });
  document.getElementById("save").addEventListener("click", () => saveEdit(note));
}

async function saveEdit(note) {
  const patch = {};
  contentEl.querySelectorAll("[data-field]").forEach((input) => {
    patch[input.dataset.field] = input.value;
  });
  const result = await api(`/sync/note/${note.id}`, { method: "PATCH", body: JSON.stringify(patch) });
  if (!result.ok) {
    document.getElementById("edit-errors").textContent = result.errors.join("; ");
    return;
  }
  Object.assign(note, patch);
  state.editing = false;
  renderReview();
}

async function submitRating(rating) {
  const note = currentNote();
  await api("/sync/review", {
    method: "POST",
    body: JSON.stringify({
      reviewId: crypto.randomUUID(),
      noteId: note.id,
      cardKind: note.cardKind,
      rating,
      reviewedAt: new Date().toISOString(),
    }),
  });
  state.sessionCount++;
  // Show the next card now. The deck counts above it are worth refreshing, but
  // they are not worth waiting for: /sync/decks recomputes every deck's due
  // buckets and was measured at 3-4 seconds, which used to sit between the tap
  // and the next card on every single rating (issue #16). It updates in place
  // when it lands, a moment after the card is already on screen.
  advance();
  refreshStatsStrip().catch((e) => console.error("stats strip refresh failed", e));
}

async function suspendCurrent() {
  const note = currentNote();
  await api("/sync/suspend", {
    method: "POST",
    body: JSON.stringify({ noteId: note.id, cardKind: note.cardKind, suspended: true }),
  });
  advance();
}

async function deleteCurrent() {
  const note = currentNote();
  if (!confirm(`Delete "${note.lemma}" permanently? This removes its review history too.`)) return;
  await api(`/sync/note/${note.id}`, { method: "DELETE" });
  advance();
}

function advance() {
  state.queue.splice(state.index, 1);
  state.revealed = false;
  state.editing = false;
  state.recording = "idle";
  state.pronunciationResult = null;
  renderReview();
}

// ---------------------------------------------------------------------------
// Pronunciation (D18) — record an attempt, score it via /pronounce/score,
// submit the resulting rating through the exact same /sync/review submitRating()
// every other card uses. No separate scheduling path for pronunciation notes —
// only a different way of arriving at a rating.
// ---------------------------------------------------------------------------

let mediaRecorder = null;
let recordedChunks = [];

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result.slice(reader.result.indexOf(",") + 1));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

async function startRecording() {
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch (e) {
    console.error(e);
    state.pronunciationResult = { error: "Microphone access was denied or unavailable." };
    renderReview();
    return;
  }
  recordedChunks = [];
  mediaRecorder = new MediaRecorder(stream);
  mediaRecorder.addEventListener("dataavailable", (e) => {
    if (e.data.size > 0) recordedChunks.push(e.data);
  });
  mediaRecorder.start();
  state.recording = "recording";
  state.pronunciationResult = null;
  renderReview();
}

function stopRecording() {
  return new Promise((resolve) => {
    mediaRecorder.addEventListener("stop", () => {
      const blob = new Blob(recordedChunks, { type: mediaRecorder.mimeType || "audio/webm" });
      mediaRecorder.stream.getTracks().forEach((track) => track.stop());
      resolve(blob);
    }, { once: true });
    mediaRecorder.stop();
  });
}

async function stopAndScore() {
  const blob = await stopRecording();
  state.recording = "scoring";
  renderReview();

  try {
    const audioBase64 = await blobToBase64(blob);
    const result = await api("/pronounce/score", {
      method: "POST",
      body: JSON.stringify({
        noteId: currentNote().id,
        audioBase64,
        mediaType: blob.type || "audio/webm",
      }),
    });
    state.pronunciationResult = result;
    state.recording = "scored";
  } catch (e) {
    console.error(e);
    state.pronunciationResult = { error: e.message ?? "Scoring failed. Try again." };
    state.recording = "idle";
  }
  renderReview();
}

/** The rating a scored attempt produced goes through submitRating() unchanged —
 * pronunciation notes only ever have a 'recall' card (never hasSpelling), so
 * currentNote().cardKind is always right for the /sync/review call it makes. */
async function continueAfterScore() {
  const rating = state.pronunciationResult.rating;
  await submitRating(rating);
}

function renderPronunciationReview(note) {
  const result = state.pronunciationResult;
  contentEl.innerHTML = `
    <div id="card">
      <div id="lemma">${escapeHtml(note.lemma)}</div>
      <div class="translation">${escapeHtml(note.lemmaTranslation)}</div>
      ${note.gloss ? `<div class="gloss">${escapeHtml(note.gloss)}</div>` : ""}
      ${note.audioUrl ? `<audio controls src="${escapeHtml(note.audioUrl)}" style="margin-top: 12px"></audio>` : ""}

      <div id="pronunciation-control">
        ${
          state.recording === "recording"
            ? `<button id="mic-btn" class="mic-btn recording">⏹</button>
               <div id="pronunciation-status">Recording — tap to stop</div>`
            : state.recording === "scoring"
            ? `<button class="mic-btn" disabled>…</button>
               <div id="pronunciation-status">Scoring…</div>`
            : `<button id="mic-btn" class="mic-btn">🎤</button>
               <div id="pronunciation-status">Tap to record yourself saying this</div>`
        }
      </div>

      ${
        result && !result.error
          ? `<div id="pronunciation-result" class="bucket-${result.bucket}">
               <div class="bucket-label">${result.bucket.toUpperCase()}</div>
               <div class="transcript">Heard: "${escapeHtml(result.transcript)}"</div>
             </div>
             <button id="continue-btn">Continue</button>`
          : ""
      }
      ${result?.error ? `<div id="pronunciation-error">${escapeHtml(result.error)}</div>` : ""}

      <div id="tools-row">
        <button id="suspend">Suspend</button>
        <button id="delete">Delete</button>
      </div>
    </div>
  `;

  const micBtn = document.getElementById("mic-btn");
  if (micBtn && state.recording === "idle") micBtn.addEventListener("click", startRecording);
  if (micBtn && state.recording === "recording") micBtn.addEventListener("click", stopAndScore);
  document.getElementById("continue-btn")?.addEventListener("click", continueAfterScore);
  document.getElementById("suspend").addEventListener("click", suspendCurrent);
  document.getElementById("delete").addEventListener("click", deleteCurrent);
}

// ---------------------------------------------------------------------------

async function main() {
  captureTokenFromUrl();
  if (!getToken()) {
    contentEl.innerHTML = `<div id="error">No access token. Open your install link again.</div>`;
    return;
  }
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("./sw.js").catch((e) => console.error("sw registration failed", e));
  }
  if (navigator.onLine) await flushPendingReviews(); // queued from a previous offline stretch
  await showDeckList();
}

main();
