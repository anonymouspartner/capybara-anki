// The reviewer — step 2 of docs/DESIGN.md's build order, redesigned to match
// AnkiDroid's own layout and dark theme after seeing real screenshots of it (deck
// list with new/learning/review counts, the stats strip, card front/back
// hierarchy, the four-button rating bar). Still deliberately plain JS, no build
// step: every scheduling decision lives server-side (src/review/), so this file's
// job is fetch → render → post an answer → next card.
//
// Only two decks are reviewable here (Ukrainian, English) — real AnkiDroid's deck
// list also has Grammar, Spelling, and Pronunciation, but those last two are
// genuinely different card shapes (a fill-in-blank and an audio+mic card, not the
// Capybara vocabulary note this reviewer knows how to render — see docs/DESIGN.md
// §7.5 finding 5 and §11) and Grammar depends on whether its real notes share the
// vocabulary schema, which nothing here has confirmed yet. Showing empty rows for
// decks this app can't actually review would be worse than not showing them.
//
// Auth (D13, §4.5): install is opening one link, `#t=<token>`. Read the fragment,
// store the token, strip it from the visible URL and history so it never lingers
// there or gets shared by accident — then send it as a bearer token on every call.

const TOKEN_KEY = "capybara-anki-token";

function captureTokenFromUrl() {
  // location.hash includes the leading "#" itself (e.g. "#t=abc"), which
  // URLSearchParams doesn't expect — strip it before parsing, not after.
  const params = new URLSearchParams(location.hash.slice(1));
  const token = params.get("t");
  if (!token) return;
  localStorage.setItem(TOKEN_KEY, token);
  history.replaceState(null, "", location.pathname + location.search);
}

function getToken() {
  return localStorage.getItem(TOKEN_KEY);
}

async function api(path, options = {}) {
  const token = getToken();
  const res = await fetch(path, {
    ...options,
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...options.headers,
    },
  });
  if (!res.ok && res.status !== 400) {
    throw new Error(`${options.method ?? "GET"} ${path} -> ${res.status}`);
  }
  return res.json();
}

const contentEl = document.getElementById("content");
const titleEl = document.getElementById("title");
const backBtn = document.getElementById("back-btn");
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
    <div id="session-footer">Studied ${state.sessionCount} card${state.sessionCount === 1 ? "" : "s"} this session</div>
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
  titleEl.textContent = deck;

  contentEl.innerHTML = `<div style="padding: 40px; text-align: center; color: var(--fg-muted)">Loading…</div>`;
  try {
    state.queue = await api(`/sync/due?deck=${encodeURIComponent(deck)}`);
  } catch (e) {
    contentEl.innerHTML = `<div id="error">Couldn't load this deck.</div>`;
    console.error(e);
    return;
  }
  updateStatsStrip();
  renderReview();
}

function currentNote() {
  return state.queue[state.index] ?? null;
}

function updateStatsStrip() {
  const deckSummary = state.decks.find((d) => d.deck === state.currentDeck);
  if (!deckSummary) {
    statsStrip.hidden = true;
    return;
  }
  statsStrip.hidden = false;
  statsStrip.innerHTML = `
    <span class="new">${deckSummary.newCount}</span>
    <span class="learning">${deckSummary.learningCount}</span>
    <span class="review">${deckSummary.reviewCount}</span>
  `;
}

/** Refreshes the stats strip from the server after an answer — matching real
 * Anki's live countdown, but by asking rather than guessing. An earlier version
 * of this tried to derive "was this card new or review" client-side from queue
 * position; that's exactly the kind of scheduling classification src/review/
 * already does correctly and the client has no business re-deriving badly. */
async function refreshStatsStrip() {
  state.decks = await api("/sync/decks");
  updateStatsStrip();
}

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

  contentEl.innerHTML = `
    <div id="card">
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
      rating,
      reviewedAt: new Date().toISOString(),
    }),
  });
  state.sessionCount++;
  await refreshStatsStrip();
  advance();
}

async function suspendCurrent() {
  const note = currentNote();
  await api("/sync/suspend", { method: "POST", body: JSON.stringify({ noteId: note.id, suspended: true }) });
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
  renderReview();
}

// ---------------------------------------------------------------------------

async function main() {
  captureTokenFromUrl();
  if (!getToken()) {
    contentEl.innerHTML = `<div id="error">No access token. Open your install link again.</div>`;
    return;
  }
  await showDeckList();
}

main();
