// The reviewer — step 2 of docs/DESIGN.md's build order. Deliberately plain JS,
// no build step: every bit of scheduling logic lives server-side (src/review/), so
// this file's whole job is fetch → render → post an answer → next card. There is
// nothing here worth a bundler.
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

const cardEl = document.getElementById("card");

const state = {
  queue: [],
  index: 0,
  revealed: false,
  editing: false,
};

function currentNote() {
  return state.queue[state.index] ?? null;
}

function escapeHtml(s) {
  return (s ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

function render() {
  const note = currentNote();
  if (!note) {
    cardEl.innerHTML = `<div id="empty">Nothing due right now. 🎉</div>`;
    return;
  }

  if (state.editing) {
    renderEditForm(note);
    return;
  }

  cardEl.innerHTML = `
    <div id="lemma">${escapeHtml(note.lemma)}</div>
    <div id="back" class="${state.revealed ? "visible" : ""}">
      <div class="translation">${escapeHtml(note.lemmaTranslation)}</div>
      <div class="gloss">${escapeHtml(note.gloss)}</div>
      <div class="pos">${escapeHtml(note.partOfSpeech)}</div>
      ${note.example ? `<div class="example">${escapeHtml(note.example)}</div>` : ""}
      ${note.exampleTranslation ? `<div class="example-translation">${escapeHtml(note.exampleTranslation)}</div>` : ""}
    </div>
    ${
      state.revealed
        ? `<div id="rating-row">
             <button class="rating-again" data-rating="1">Again</button>
             <button class="rating-hard" data-rating="2">Hard</button>
             <button class="rating-good" data-rating="3">Good</button>
             <button class="rating-easy" data-rating="4">Easy</button>
           </div>`
        : `<div id="reveal-row"><button id="reveal">Show answer</button></div>`
    }
    <div id="tools-row">
      <button id="edit">Edit</button>
      <button id="suspend">Suspend</button>
      <button id="delete">Delete</button>
    </div>
  `;

  document.getElementById("reveal")?.addEventListener("click", () => {
    state.revealed = true;
    render();
  });
  cardEl.querySelectorAll("[data-rating]").forEach((btn) => {
    btn.addEventListener("click", () => submitRating(Number(btn.dataset.rating)));
  });
  document.getElementById("edit").addEventListener("click", () => {
    state.editing = true;
    render();
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
  cardEl.innerHTML = `
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
    render();
  });
  document.getElementById("save").addEventListener("click", () => saveEdit(note));
}

async function saveEdit(note) {
  const patch = {};
  cardEl.querySelectorAll("[data-field]").forEach((input) => {
    patch[input.dataset.field] = input.value;
  });
  const result = await api(`/sync/note/${note.id}`, { method: "PATCH", body: JSON.stringify(patch) });
  if (!result.ok) {
    document.getElementById("edit-errors").textContent = result.errors.join("; ");
    return;
  }
  Object.assign(note, patch);
  state.editing = false;
  render();
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
  render();
}

async function main() {
  captureTokenFromUrl();
  if (!getToken()) {
    cardEl.innerHTML = `<div id="error">No access token. Open your install link again.</div>`;
    return;
  }
  try {
    state.queue = await api("/sync/due");
  } catch (e) {
    cardEl.innerHTML = `<div id="error">Couldn't load the due queue.</div>`;
    console.error(e);
    return;
  }
  render();
}

main();
