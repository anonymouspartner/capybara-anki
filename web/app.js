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
// Auth: two ways in, both resolved by `auth.js` (shared with scan.js/stats.js),
// so this file only ever asks for a finished Authorization header. Outside
// Telegram it's D13's device token (§4.5) — install is opening one link,
// `#t=<token>`, which auth.js stores and strips from the visible URL so it never
// lingers there or gets shared by accident. Inside Telegram (#17) it's the
// signed `initData` Telegram issues per launch, which the server verifies
// rather than compares.
//
// Offline (step 3, §6): `offline.js` is the IndexedDB-backed review queue and
// response cache; `api()` below is the one place that decides when to fall back to
// it, so every call site (submitRating, refreshStatsStrip, enterDeck, …) stays
// offline-safe automatically rather than each needing its own try/catch.

import * as offline from "./offline.js";
import { authHeader, captureTokenFromUrl, isTelegramMiniApp } from "./auth.js";
import { haptic, initTelegram } from "./telegram.js";
import { API_BASE } from "./config.js";

async function api(path, options = {}) {
  const auth = authHeader();
  const method = options.method ?? "GET";
  try {
    const res = await fetch(API_BASE + path, {
      ...options,
      headers: {
        "content-type": "application/json",
        ...(auth ? { authorization: auth } : {}),
        ...options.headers,
      },
    });
    if (!res.ok && res.status !== 400) {
      const error = new Error(`${method} ${path} -> ${res.status}`);
      // Carried as a field rather than parsed back out of the message, so a
      // caller can tell "you aren't who you say you are" from "that broke".
      error.status = res.status;
      throw error;
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
const addLink = document.getElementById("add-link");
const settingsLink = document.getElementById("settings-link");
const statsStrip = document.getElementById("stats-strip");
const noticeEl = document.getElementById("notice");

const state = {
  view: "decks", // "decks" | "review"
  decks: [],
  currentDeck: null,
  queue: [],
  index: 0,
  revealed: false,
  editing: false,
  sessionCount: 0,
  // The last answer given in this session: { note, index, reviewId, queued }.
  // Undo needs the note object and the queue slot it came out of, and needs to
  // know whether the answer reached the server at all (see undoLast).
  lastAnswered: null,
  // D18 (pronunciation notes): "idle" | "recording" | "scoring" | "scored".
  recording: "idle",
  // What has been typed into a spelling card so far, kept in state because every
  // keystroke can outlive a re-render.
  spellingAnswer: "",
  pronunciationResult: null, // { transcript, similarity, bucket, rating } | { error } | null
  // GET /sync/me: who's who, streaks, today's progress. null when the server is
  // older than the endpoint, or offline with nothing cached -- the deck list then
  // falls back to one ungrouped list.
  me: null,
  // Ids of the other people whose decks are unfolded on the deck list -- one
  // flag per person, since every person who isn't you gets their own toggle.
  openPeople: new Set(),
  // The deck session in progress, for the progress bar and the end-of-session
  // screen: { startedAt, answered, again }.
  session: null,
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
addLink.addEventListener("click", showAddCardForm);
settingsLink.addEventListener("click", showSettingsForm);

// ---------------------------------------------------------------------------
// Deck list
// ---------------------------------------------------------------------------

async function showDeckList() {
  state.view = "decks";
  backBtn.hidden = true;
  scanLink.hidden = false;
  addLink.hidden = false;
  settingsLink.hidden = false;
  titleEl.textContent = "Capybara";
  statsStrip.hidden = true;
  // The notice describes an answer inside a deck session; leaving the deck ends
  // that session, and `lastAnswered` holds a queue slot that no longer exists.
  state.lastAnswered = null;
  hideNotice();

  contentEl.innerHTML = `<div style="padding: 40px; text-align: center; color: var(--fg-muted)">Loading…</div>`;
  try {
    // /sync/me is optional polish: a failure there (an older server, offline with
    // nothing cached) must not cost the deck list itself.
    [state.decks, state.me] = await Promise.all([
      api("/sync/decks"),
      api("/sync/me").catch((e) => {
        console.error("/sync/me failed", e);
        return null;
      }),
    ]);
  } catch (e) {
    // Inside Telegram a 401 has one likely cause worth naming: the credential
    // was signed correctly, but this Telegram account isn't one of the two this
    // instance is configured for. "Couldn't load decks" sends someone hunting
    // for a network problem that isn't there.
    contentEl.innerHTML = e.status === 401 && isTelegramMiniApp()
      ? `<div id="error">This Telegram account isn't set up for this collection.</div>`
      : `<div id="error">Couldn't load decks.</div>`;
    console.error(e);
    return;
  }
  renderDeckList();
}

const LANGUAGE_NAMES = { uk: "Ukrainian", en: "English" };
const LANGUAGE_FLAGS = { uk: "🇺🇦", en: "🇬🇧" };

/** A deck's language, from the server when it says (DeckSummary.language),
 * otherwise from the name -- the same rule as src/review/types.ts's
 * languageOfDeck, for a server that predates the field. */
function deckLanguage(d) {
  if (d.language) return d.language;
  for (const [code, name] of Object.entries(LANGUAGE_NAMES)) {
    if (d.deck === name || d.deck.startsWith(`${name} `)) return code;
  }
  return undefined;
}

/** Inside a person's group the language is already said once in the header, so
 * a row reads by its topic: "Ukrainian Spelling" -> "Spelling", and the plain
 * language deck -> "Vocabulary". */
function deckTopic(d) {
  const name = LANGUAGE_NAMES[deckLanguage(d)];
  if (!name) return d.deck;
  if (d.deck === name) return "Vocabulary";
  return d.deck.slice(name.length + 1);
}

const TOPIC_ICONS = { Vocabulary: "📘", Spelling: "✏️", Grammar: "🧩", Pronunciation: "🎙️" };

function dueCount(d) {
  return d.newCount + d.learningCount + d.reviewCount;
}

function deckRowHtml(d, { grouped }) {
  const label = grouped ? deckTopic(d) : d.deck;
  return `
    <div class="deck-row" data-deck="${escapeHtml(d.deck)}">
      <span class="deck-icon">${TOPIC_ICONS[deckTopic(d)] ?? "🗂️"}</span>
      <span class="deck-name">${escapeHtml(label)}</span>
      <span class="deck-counts">
        <span class="new">${d.newCount}</span>
        <span class="learning">${d.learningCount}</span>
        <span class="review">${d.reviewCount}</span>
      </span>
    </div>
  `;
}

/** One person's block: who they are, their streak, today's goal, a big START
 * into their first deck with anything due, and their decks. The other person's
 * decks stay folded by default -- studying them spends that person's schedule
 * (one schedule per card, shared collection), so it should be deliberate. */
function personHtml(person, decks, dailyGoal) {
  const firstDue = decks.find((d) => dueCount(d) > 0);
  const lang = person.learningLanguage;
  const learning = LANGUAGE_NAMES[lang] ? `learning ${LANGUAGE_FLAGS[lang]} ${LANGUAGE_NAMES[lang]}` : "";
  const goalPct = Math.min(100, Math.round((person.reviewedToday / dailyGoal) * 100));
  const open = person.isYou || state.openPeople.has(person.id);
  const streakDays = `${person.streak} day${person.streak === 1 ? "" : "s"}`;
  return `
    <section class="person ${person.isYou ? "you" : "partner"}">
      <div class="person-head">
        <div class="avatar">${escapeHtml(person.name.slice(0, 1).toUpperCase())}</div>
        <div class="person-who">
          <div class="person-name">${escapeHtml(person.isYou ? `${person.name} (you)` : person.name)}</div>
          <div class="person-sub">${learning}</div>
        </div>
        <div class="streak ${person.streak > 0 ? "" : "cold"}" title="Streak: ${streakDays}">🔥 ${person.streak}</div>
      </div>
      <div class="goal">
        <div class="goal-label">
          <span>Daily goal</span>
          <span>${Math.min(person.reviewedToday, dailyGoal)} / ${dailyGoal}${person.reviewedToday >= dailyGoal ? " ✓" : ""}</span>
        </div>
        <div class="progress ${person.reviewedToday >= dailyGoal ? "gold" : ""}"><span style="width:${goalPct}%"></span></div>
      </div>
      ${
        person.isYou
          ? firstDue
            ? `<button class="btn-3d start-btn" data-deck="${escapeHtml(firstDue.deck)}">Start · ${escapeHtml(deckTopic(firstDue))}</button>`
            : `<div class="all-done">✓ All caught up for today</div>`
          : `<button class="partner-toggle" data-person="${escapeHtml(person.id)}">${open ? "Hide" : "Show"} ${escapeHtml(person.name)}'s decks</button>`
      }
      ${
        open
          ? `${!person.isYou ? `<div class="partner-note">These are ${escapeHtml(person.name)}'s — studying them changes ${escapeHtml(person.name)}'s schedule.</div>` : ""}
             ${decks.map((d) => deckRowHtml(d, { grouped: true })).join("")}`
          : ""
      }
    </section>
  `;
}

function renderDeckList() {
  const people = state.me?.people ?? [];
  const you = people.find((p) => p.isYou);
  // The title counts what's due for YOU when that's known -- the other person's
  // decks aren't yours to clear.
  const yours = you ? state.decks.filter((d) => deckLanguage(d) === you.learningLanguage) : state.decks;
  const totalDue = yours.reduce((sum, d) => sum + dueCount(d), 0);
  titleEl.textContent = `Capybara — ${totalDue} due`;

  let body;
  // Grouped only when the server says which person is asking: without that there is
  // no "your" group to lead with or start from, so the plain list is the safer view.
  if (people.length > 0 && you) {
    const claimed = new Set();
    body = people.map((person) => {
      const decks = state.decks.filter((d) => deckLanguage(d) === person.learningLanguage);
      decks.forEach((d) => claimed.add(d.deck));
      return personHtml(person, decks, state.me.dailyGoal ?? 20);
    }).join("");
    const other = state.decks.filter((d) => !claimed.has(d.deck));
    if (other.length > 0) {
      body += `<section class="person"><div class="person-name">Shared</div>${
        other.map((d) => deckRowHtml(d, { grouped: false })).join("")
      }</section>`;
    }
  } else {
    body = state.decks.map((d) => deckRowHtml(d, { grouped: false })).join("");
  }

  contentEl.innerHTML = `
    ${body}
    <div id="session-footer">
      Studied ${state.sessionCount} card${state.sessionCount === 1 ? "" : "s"} this session
      · <a href="./stats.html">Stats</a>
    </div>
  `;
  contentEl.querySelectorAll(".deck-row, .start-btn").forEach((el) => {
    el.addEventListener("click", () => enterDeck(el.dataset.deck));
  });
  contentEl.querySelectorAll(".partner-toggle").forEach((btn) => {
    btn.addEventListener("click", () => {
      const id = btn.dataset.person;
      if (state.openPeople.has(id)) state.openPeople.delete(id);
      else state.openPeople.add(id);
      renderDeckList();
    });
  });
}

// ---------------------------------------------------------------------------
// Add a card (Phase 5.2) — the one other way a note enters this app besides
// /scan and capybara-bot's own /learn. Deliberately stays open after a
// successful save rather than returning to the deck list: the real use this
// was built for is typing a short list of words in one sitting, and bouncing
// back to "Capybara" after every single word would make that the slower path.
// ---------------------------------------------------------------------------

const newCardState = { language: "uk" };

function showAddCardForm() {
  state.view = "add";
  backBtn.hidden = false;
  scanLink.hidden = true;
  addLink.hidden = true;
  settingsLink.hidden = true;
  statsStrip.hidden = true;
  titleEl.textContent = "Add card";
  hideNotice();
  renderAddCardForm();
}

function renderAddCardForm() {
  const fields = [
    ["lemmaTranslation", "Translation"],
    ["gloss", "Gloss"],
    ["partOfSpeech", "Part of speech"],
    ["example", "Example"],
    ["exampleTranslation", "Example translation"],
  ];
  contentEl.innerHTML = `
    <div id="edit-form" class="visible">
      <label>Language
        <select id="add-language">
          <option value="uk" ${newCardState.language === "uk" ? "selected" : ""}>Ukrainian</option>
          <option value="en" ${newCardState.language === "en" ? "selected" : ""}>English</option>
        </select>
      </label>
      <label>Lemma
        <input id="add-lemma" data-field="lemma" value="${escapeHtml(newCardState.lemma ?? "")}" autofocus />
      </label>
      ${
        fields.map(([key, label]) => `
          <label>${label}
            <input data-field="${key}" value="${escapeHtml(newCardState[key] ?? "")}" />
          </label>
        `).join("")
      }
      <div id="edit-errors"></div>
      <div id="tools-row">
        <button id="save">Add</button>
        <button id="cancel">Done</button>
      </div>
    </div>
  `;
  document.getElementById("add-language").addEventListener("change", (e) => {
    newCardState.language = e.target.value;
  });
  document.getElementById("cancel").addEventListener("click", showDeckList);
  document.getElementById("save").addEventListener("click", saveNewCard);
  document.getElementById("add-lemma").focus();
}

async function saveNewCard() {
  const input = { language: newCardState.language };
  contentEl.querySelectorAll("[data-field]").forEach((el) => {
    input[el.dataset.field] = el.value.trim() || null;
  });
  const result = await api("/sync/note", { method: "POST", body: JSON.stringify(input) });
  if (!result.ok) {
    document.getElementById("edit-errors").textContent = result.errors.join("; ");
    return;
  }
  showNotice(`Added "${input.lemma}"`);
  // Language carries over (adding several words in the same language in a row
  // is the common case); everything else about the word just added does not.
  Object.keys(newCardState).forEach((key) => { if (key !== "language") delete newCardState[key]; });
  renderAddCardForm();
}

// ---------------------------------------------------------------------------
// Settings (Phase 5.3) — daily limits, retention, rollover, timezone, leech
// threshold/action: the last of §4's "SQL-only" gaps. Loads the current
// `scheduler_config` row, edits a copy of it locally, and only writes back
// (as a patch of whatever actually changed) on Save — Cancel discards the
// copy and the server is never touched, same "nothing is submitted until
// asked" shape as the add-a-card and edit-in-place forms.
// ---------------------------------------------------------------------------

let settingsDraft = null;
/** What was actually loaded from the server — the baseline `saveSettings`
 * diffs the draft against, so a Save only ever sends the fields someone
 * really changed, not a full row every time (an edit-in-place patch, not a
 * blind overwrite). */
let settingsBaseline = null;

async function showSettingsForm() {
  state.view = "settings";
  backBtn.hidden = false;
  scanLink.hidden = true;
  addLink.hidden = true;
  settingsLink.hidden = true;
  statsStrip.hidden = true;
  titleEl.textContent = "Settings";
  hideNotice();

  contentEl.innerHTML = `<div style="padding: 40px; text-align: center; color: var(--fg-muted)">Loading…</div>`;
  try {
    settingsBaseline = await api("/sync/settings");
  } catch (e) {
    contentEl.innerHTML = `<div id="error">Couldn't load settings.</div>`;
    console.error(e);
    return;
  }
  settingsDraft = { ...settingsBaseline };
  renderSettingsForm();
}

/** One field's editor: `type` picks the input widget (all the settings screen
 * needs is text and select — a leech action is one of two words, not free
 * text), `value`/`onchange` translate between the input's string and the
 * config row's real type (number, or `null` for "unset time zone"). */
const SETTINGS_FIELDS = [
  {
    key: "dailyNewLimit",
    label: "Daily new card limit",
    type: "number",
    toInput: (v) => String(v),
    fromInput: (s) => Number(s),
  },
  {
    key: "dailyReviewLimit",
    label: "Daily review limit",
    type: "number",
    toInput: (v) => String(v),
    fromInput: (s) => Number(s),
  },
  {
    key: "desiredRetention",
    label: "Desired retention (0–1)",
    type: "number",
    step: "0.01",
    toInput: (v) => String(v),
    fromInput: (s) => Number(s),
  },
  {
    key: "rolloverHour",
    label: "Day rollover hour (0–23)",
    type: "number",
    toInput: (v) => String(v),
    fromInput: (s) => Number(s),
  },
  {
    key: "timeZone",
    label: "Time zone (IANA name, blank for UTC)",
    type: "text",
    toInput: (v) => v ?? "",
    fromInput: (s) => (s.trim() === "" ? null : s.trim()),
  },
  {
    key: "leechThreshold",
    label: "Leech threshold (0 disables it)",
    type: "number",
    toInput: (v) => String(v),
    fromInput: (s) => Number(s),
  },
];

function renderSettingsForm() {
  contentEl.innerHTML = `
    <div id="edit-form" class="visible">
      ${
        SETTINGS_FIELDS.map((field) => `
          <label>${field.label}
            <input data-setting="${field.key}" type="${field.type}" ${field.step ? `step="${field.step}"` : ""}
                   value="${escapeHtml(field.toInput(settingsDraft[field.key]))}" />
          </label>
        `).join("")
      }
      <label>Leech action
        <select data-setting="leechAction">
          <option value="tag" ${settingsDraft.leechAction === "tag" ? "selected" : ""}>Tag (announce only)</option>
          <option value="suspend" ${settingsDraft.leechAction === "suspend" ? "selected" : ""}>Suspend</option>
        </select>
      </label>
      <div id="edit-errors"></div>
      <div id="tools-row">
        <button id="save">Save</button>
        <button id="cancel">Cancel</button>
      </div>
    </div>
  `;
  contentEl.querySelectorAll("[data-setting]").forEach((el) => {
    el.addEventListener("change", () => {
      const field = SETTINGS_FIELDS.find((f) => f.key === el.dataset.setting);
      settingsDraft[el.dataset.setting] = field ? field.fromInput(el.value) : el.value;
    });
  });
  document.getElementById("cancel").addEventListener("click", showDeckList);
  document.getElementById("save").addEventListener("click", saveSettings);
}

/** Only the fields that actually changed — same "a patch, not a blind
 * overwrite" shape `saveEdit` uses for notes, and it means a stray
 * `Number("")` (`NaN`, from a field nobody touched but the browser still
 * round-tripped) can never leak into the request. */
function changedSettings() {
  const patch = {};
  for (const key of Object.keys(settingsDraft)) {
    if (settingsDraft[key] !== settingsBaseline[key]) patch[key] = settingsDraft[key];
  }
  return patch;
}

async function saveSettings() {
  const patch = changedSettings();
  if (Object.keys(patch).length === 0) {
    await showDeckList();
    return;
  }
  const result = await api("/sync/settings", { method: "POST", body: JSON.stringify(patch) });
  if (!result.ok) {
    document.getElementById("edit-errors").textContent = result.errors.join("; ");
    return;
  }
  await showDeckList();
  showNotice("Settings saved");
}

// ---------------------------------------------------------------------------
// Review
// ---------------------------------------------------------------------------

async function enterDeck(deck) {
  state.view = "review";
  state.currentDeck = deck;
  state.session = { startedAt: Date.now(), answered: 0, again: 0 };
  state.index = 0;
  state.revealed = false;
  state.editing = false;
  state.lastAnswered = null;
  hideNotice();
  backBtn.hidden = false;
  scanLink.hidden = true;
  addLink.hidden = true;
  settingsLink.hidden = true;
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
  // A refresh can land after the session's last card (it isn't awaited), and
  // must not bring the strip back over the session-complete screen.
  if (!deckSummary || state.view !== "review" || !currentNote()) {
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
    const auth = authHeader();
    if (!auth) return;
    let res;
    try {
      res = await fetch(API_BASE + "/sync/review", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: auth },
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

/** The thick bar across the top of a session: answered / (answered + left).
 * The queue shrinks as cards are answered (advance()), so this needs no count
 * kept anywhere but the session's own. */
function progressHtml() {
  const answered = state.session?.answered ?? 0;
  const total = answered + state.queue.length;
  const pct = total > 0 ? Math.round((answered / total) * 100) : 0;
  return `<div id="session-progress" class="progress"><span style="width:${pct}%"></span></div>`;
}

function formatDuration(ms) {
  const seconds = Math.max(1, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}:${String(seconds % 60).padStart(2, "0")}`;
}

/** The end of a deck session: how many, how well, how long, and the streak --
 * Duolingo's lesson-complete screen. "Accuracy" is the share of answers that
 * weren't Again, the one rating that means "didn't know it". */
function renderSessionComplete() {
  const { answered, again, startedAt } = state.session;
  const accuracy = Math.round(((answered - again) / answered) * 100);
  statsStrip.hidden = true;
  hideNotice();
  contentEl.innerHTML = `
    <div id="complete">
      <div class="hero">🎉</div>
      <h2>Session complete!</h2>
      <div class="tiles">
        <div class="tile cards"><div class="tile-label">Cards</div><div class="tile-value">${answered}</div></div>
        <div class="tile accuracy"><div class="tile-label">Accuracy</div><div class="tile-value">${accuracy}%</div></div>
        <div class="tile time"><div class="tile-label">Time</div><div class="tile-value">${formatDuration(Date.now() - startedAt)}</div></div>
      </div>
      <div class="streak-line" id="complete-streak"></div>
      <button class="btn-3d" id="complete-continue">Continue</button>
    </div>
  `;
  document.getElementById("complete-continue").addEventListener("click", showDeckList);
  haptic("success");
  // The streak is the server's to count (each person's own day boundary), so ask
  // rather than guess; it fills in when it lands, and stays blank offline.
  api("/sync/me").then((me) => {
    state.me = me;
    const you = me?.people?.find((p) => p.isYou);
    const el = document.getElementById("complete-streak");
    if (you && el && you.streak > 0) el.textContent = `🔥 ${you.streak} day streak`;
  }).catch((e) => console.error("/sync/me failed", e));
}

function renderReview() {
  const note = currentNote();
  if (!note) {
    if (state.session?.answered > 0) {
      renderSessionComplete();
      return;
    }
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

  if (note.cardKind === "spelling") {
    renderSpellingReview(note);
    return;
  }

  contentEl.innerHTML = `
    ${progressHtml()}
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
        <button id="bury">Bury</button>
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
          : `<button id="reveal-btn" class="btn-3d blue">Show answer</button>`
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
  document.getElementById("bury").addEventListener("click", buryCurrent);
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

const RATING_NAMES = { 1: "Again", 2: "Hard", 3: "Good", 4: "Easy" };

function hideNotice() {
  noticeEl.hidden = true;
  noticeEl.className = "";
  noticeEl.innerHTML = "";
}

/** The one-line report of what was just recorded, and the way back from it.
 *
 * Deliberately not auto-dismissing on a timer: the whole reason to read it is to
 * notice you tapped the wrong button, and a toast that vanishes after three
 * seconds is exactly the thing a person looking down at a keyboard misses. It
 * clears when the next answer replaces it, or when Undo is taken. */
function showNotice(text, { leech = false, undo = null } = {}) {
  noticeEl.hidden = false;
  noticeEl.className = leech ? "leech" : "";
  noticeEl.innerHTML = `<span class="notice-text"></span>${undo ? `<button id="undo-btn">Undo</button>` : ""}`;
  // textContent, not innerHTML: a leech notice names the card, and card content
  // is user data that must never be parsed as markup.
  noticeEl.querySelector(".notice-text").textContent = text;
  if (undo) document.getElementById("undo-btn").addEventListener("click", undo);
}

/** Takes back the last answer, server-side, and puts the card back in front of
 * you. The server rebuilds the card from its remaining review log, so what comes
 * back is the card exactly as it was — this side only has to restore the queue
 * position it was pulled from. */
async function undoLast() {
  const last = state.lastAnswered;
  if (!last) return;
  state.lastAnswered = null;
  try {
    if (last.queued) {
      // The answer never reached the server — it is sitting in the local outbox.
      // Undo here means dropping it from that queue, not asking the server to
      // delete a review it has never seen.
      await offline.removePendingReview(last.reviewId);
    } else {
      await api("/sync/undo", {
        method: "POST",
        body: JSON.stringify({ noteId: last.note.id, cardKind: last.note.cardKind }),
      });
    }
  } catch (e) {
    showNotice("Couldn't undo that — it may already be synced from another device.");
    console.error(e);
    return;
  }
  hideNotice();
  state.sessionCount = Math.max(0, state.sessionCount - 1);
  if (state.session) {
    state.session.answered = Math.max(0, state.session.answered - 1);
    if (last.rating === 1) state.session.again = Math.max(0, state.session.again - 1);
  }
  // Put it back where it was taken from, unrevealed, so undo lands you on the
  // card you meant to answer rather than somewhere else in the queue. Its
  // interval previews came from the state the server has just restored, so they
  // are correct again by construction.
  state.queue.splice(last.index, 0, last.note);
  state.index = last.index;
  state.revealed = false;
  state.editing = false;
  renderReview();
  refreshStatsStrip().catch((e) => console.error("stats strip refresh failed", e));
}

async function submitRating(rating) {
  const note = currentNote();
  const index = state.index;
  const reviewId = crypto.randomUUID();
  const result = await api("/sync/review", {
    method: "POST",
    body: JSON.stringify({
      reviewId,
      noteId: note.id,
      cardKind: note.cardKind,
      rating,
      reviewedAt: new Date().toISOString(),
    }),
  });
  state.sessionCount++;
  if (state.session) {
    state.session.answered++;
    if (rating === 1) state.session.again++;
  }
  haptic("tap");
  state.lastAnswered = { note, index, reviewId, rating, queued: result?.queued === true };
  // `leech` is only present from a server new enough to send it; older ones
  // simply fall through to the plain notice.
  if (result?.leech) {
    showNotice(`"${note.lemma}" keeps being forgotten — it's a leech now.`, { leech: true, undo: undoLast });
  } else {
    showNotice(RATING_NAMES[rating] ?? "Recorded", { undo: undoLast });
  }
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

async function buryCurrent() {
  const note = currentNote();
  await api("/sync/bury", {
    method: "POST",
    body: JSON.stringify({ noteId: note.id, cardKind: note.cardKind, buried: true }),
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
  state.spellingAnswer = "";
  renderReview();
}

/** `uk`/`en` → the word the real `Capybara+` note type's front template
 * splices into `{{part_of_speech}}<span id="lang"></span>` via its own inline
 * script (`m={uk:"Ukrainian",en:"English"}`). Kept identical so the two
 * languages this app ever has (capybara-bot's whole scope) read the same way
 * here as they did in AnkiDroid. */
const SPELLING_LANGUAGE_NAMES = { uk: "Ukrainian", en: "English" };

/**
 * A spelling card: produce the word rather than recognise it.
 *
 * This is the `Capybara+` note type's second template — read directly off a
 * real export's card templates rather than guessed, front and back:
 *
 *   Front: {{lemma_translation}} (the "meaning"), {{part_of_speech}} plus the
 *   language name, then {{example_translation}} as the clue — the TRANSLATED
 *   example, not the target-language one, so the prompt never leaks the word
 *   being spelled — and Anki's own {{type:lemma}} entry field.
 *   Back: {{FrontSide}}, a divider, {{lemma}} itself, then the real
 *   {{example}} (now safe to show whole, unblanked) and {{example_translation}}
 *   again below it.
 *
 * One thing Anki's card does that this can't reproduce natively: the live
 * red/green diff inside the type box as you type is AnkiDroid reviewer
 * chrome, not template content — no field describes it. The per-letter dot
 * count is also reviewer chrome rather than template content, but a real
 * AnkiDroid screenshot confirms it's still part of "what the card looks
 * like" — this used to guess it away as invented UI before checking; it
 * isn't. What this adds beyond that, still not from the template: a plain
 * "Correct"/"Not quite" verdict against the typed answer, in place of the
 * live diff this can't do. It's shown, not enforced — the four rating
 * buttons are still yours — for the same reason Anki's own type-in-the-answer
 * doesn't force a rating either: an accent typed without the right keyboard
 * layout shouldn't force an Again.
 */
function renderSpellingReview(note) {
  const answer = state.spellingAnswer ?? "";
  const languageName = SPELLING_LANGUAGE_NAMES[note.language] ?? "";
  const pos = [note.partOfSpeech, languageName ? `(${languageName})` : ""].filter(Boolean).join(" ");
  const dots = "· ".repeat(note.lemma.length).trim();

  contentEl.innerHTML = `
    ${progressHtml()}
    <div id="card">
      <div class="card-kind-badge">Spell the word for</div>
      <div id="lemma">${escapeHtml(note.lemmaTranslation ?? "")}</div>
      ${pos ? `<div class="pos">${escapeHtml(pos)}</div>` : ""}
      ${note.exampleTranslation ? `<div class="example-translation">${escapeHtml(note.exampleTranslation)}</div>` : ""}
      ${!state.revealed ? `<div id="spelling-dots">${escapeHtml(dots)}</div>` : ""}

      ${
        state.revealed
          ? `<div id="back" class="visible">
               <hr class="divider" />
               <div id="spelling-verdict" class="verdict-banner ${spellingIsCorrect(answer, note.lemma) ? "right" : "wrong"}">
                 ${spellingIsCorrect(answer, note.lemma) ? "✓ Correct!" : "✗ Not quite"}
                 ${answer ? `<div class="sub">You typed: ${escapeHtml(answer)}</div>` : ""}
               </div>
               <div id="spelling-answer">${escapeHtml(note.lemma)}</div>
               ${note.example ? `<div class="example">${escapeHtml(note.example)}</div>` : ""}
               ${note.exampleTranslation ? `<div class="example-translation">${escapeHtml(note.exampleTranslation)}</div>` : ""}
             </div>`
          : `<input id="spelling-input" type="text" autocomplete="off" autocapitalize="off"
                    autocorrect="off" spellcheck="false" placeholder="Type answer"
                    value="${escapeHtml(answer)}" />`
      }

      <div id="tools-row">
        <button id="edit">Edit</button>
        <button id="suspend">Suspend</button>
        <button id="bury">Bury</button>
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
          : `<button id="reveal-btn" class="btn-3d">Check</button>`
      }
    </div>
  `;

  const input = document.getElementById("spelling-input");
  if (input) {
    // Keep the typed text across re-renders, and let Enter check it — on a phone
    // the keyboard's own go key is the natural way to submit.
    input.addEventListener("input", () => {
      state.spellingAnswer = input.value;
    });
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        state.spellingAnswer = input.value;
        state.revealed = true;
        haptic(spellingIsCorrect(state.spellingAnswer, note.lemma) ? "success" : "error");
        renderReview();
      }
    });
    input.focus();
  }
  document.getElementById("reveal-btn")?.addEventListener("click", () => {
    state.spellingAnswer = document.getElementById("spelling-input")?.value ?? "";
    state.revealed = true;
    haptic(spellingIsCorrect(state.spellingAnswer, note.lemma) ? "success" : "error");
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
  document.getElementById("bury").addEventListener("click", buryCurrent);
  document.getElementById("delete").addEventListener("click", deleteCurrent);
}

/** Case- and whitespace-insensitive, and blind to the difference between a
 * combining accent and a precomposed one (NFC) — typing Ukrainian on a phone
 * keyboard produces either. Everything else counts: this is a spelling card. */
function spellingIsCorrect(typed, lemma) {
  const norm = (s) => s.normalize("NFC").trim().toLowerCase();
  return norm(typed) === norm(lemma);
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

/** Why a recording could not start, in words that point at the fix.
 *
 * "Denied or unavailable" was one message for several very different problems,
 * which is useless when the answer is "your client is not offering the page a
 * microphone at all". A Telegram Mini App runs in the client's webview, and a
 * webview that has not been granted the microphone does not merely refuse — it
 * often exposes no `navigator.mediaDevices` whatsoever, which is worth saying
 * plainly rather than blaming a permission the person never saw a prompt for. */
function microphoneProblem(e) {
  if (!globalThis.isSecureContext) {
    return "Recording needs a secure (https) connection.";
  }
  if (!navigator.mediaDevices?.getUserMedia) {
    return isTelegramMiniApp()
      ? "This Telegram client isn't giving the page a microphone. Open the app in a browser to record, or allow the microphone for Telegram in your phone's settings."
      : "This browser doesn't offer microphone recording.";
  }
  if (e?.name === "NotAllowedError") return "Microphone permission was denied.";
  if (e?.name === "NotFoundError") return "No microphone was found.";
  return `Couldn't start recording (${e?.name ?? "unknown error"}).`;
}

async function startRecording() {
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch (e) {
    console.error(e);
    state.pronunciationResult = { error: microphoneProblem(e) };
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
  // Nothing captured at all — a webview that hands back a silent track produces
  // this, and Whisper's "empty transcript" error is a confusing way to learn it.
  if (blob.size === 0) {
    state.pronunciationResult = { error: "No audio was captured — check the microphone and try again." };
    state.recording = "idle";
    renderReview();
    return;
  }
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
    haptic(result.bucket === "right" ? "success" : result.bucket === "close" ? "warning" : "error");
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
    ${progressHtml()}
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
             <button id="continue-btn" class="btn-3d">Continue</button>`
          : ""
      }
      ${result?.error ? `<div id="pronunciation-error">${escapeHtml(result.error)}</div>` : ""}

      <div id="tools-row">
        <button id="suspend">Suspend</button>
        <button id="bury">Bury</button>
        <button id="delete">Delete</button>
      </div>
    </div>
  `;

  const micBtn = document.getElementById("mic-btn");
  if (micBtn && state.recording === "idle") micBtn.addEventListener("click", startRecording);
  if (micBtn && state.recording === "recording") micBtn.addEventListener("click", stopAndScore);
  document.getElementById("continue-btn")?.addEventListener("click", continueAfterScore);
  document.getElementById("suspend").addEventListener("click", suspendCurrent);
  document.getElementById("bury").addEventListener("click", buryCurrent);
  document.getElementById("delete").addEventListener("click", deleteCurrent);
}

// ---------------------------------------------------------------------------

/** Phase 5.4: hands the service worker every pronunciation note's (D18)
 * reference audio URL so it can fetch-and-cache all of it in the background
 * — see sw.js's own 'cache-audio' message handler, which does the actual
 * fetching and skips whatever it already has. Fire-and-forget on purpose:
 * nothing in the review flow waits on this, so a slow network only delays
 * offline *availability* of some cards' audio, never blocks a session.
 * `navigator.serviceWorker.ready` (not `.controller`) is what to await here
 * — on the very first-ever load the worker installs and calls
 * `clients.claim()`, but this exact page load isn't `.controller`-ed until
 * that resolves; `.ready` is the promise that actually tracks it. */
async function cacheAudioOffline() {
  if (!navigator.onLine) return;
  const registration = await navigator.serviceWorker.ready;
  if (!registration.active) return;
  try {
    const urls = await api("/sync/audio-manifest");
    registration.active.postMessage({ type: "cache-audio", urls });
  } catch (e) {
    console.error("audio manifest fetch failed", e);
  }
}

async function main() {
  initTelegram();
  captureTokenFromUrl();
  if (!authHeader()) {
    contentEl.innerHTML = `<div id="error">No access token. Open your install link again.</div>`;
    return;
  }
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("./sw.js")
      .then(() => cacheAudioOffline())
      .catch((e) => console.error("sw registration failed", e));
  }
  if (navigator.onLine) await flushPendingReviews(); // queued from a previous offline stretch
  await showDeckList();
}

main();
