# Design — a self-owned replacement for Anki

**Status: design. Implementation not started.** This document is the plan of
record for this repo. It exists to be argued with, and it is expected to change as
the build teaches us things — especially §7, which rests on an assumption about the
collection export format that has not yet been checked against a real file.

It was drafted in `ukrainian-anki-scanner/docs/` before this repo existed, since that
scanner is the app being absorbed.

---

## 0. TL;DR

- Anki is already free and open source. The reason to replace it is **not cost** and
  **not the scheduler** — it is that the pipeline is one-way. Cards flow out to Anki
  and no review data ever comes back, so nothing upstream can know which words are
  actually sticking.
- The secondary reason is that roughly a third of this repo's complexity is **interop
  tax** — timestamped filenames, `.apkg`-vs-CSV, deterministic note-type ids, `#`-escaping
  — all of it there only to negotiate with a foreign app. Owning the review surface
  deletes it.
- The scope is a **PWA**: offline reviewer, FSRS scheduler, page scanner, pronunciation
  scoring, stats. One new repo. TypeScript everywhere that is hosted; one local Python
  CLI for migration.
- **FSRS is already enabled** in AnkiDroid, which means migration is a data copy rather
  than a reconstruction, and post-switch scheduling should be near-identical to today.
  This was the largest risk and it is retired.
- The safety property that makes this defensible: **`card_state` is a fold over an
  append-only `reviews` log.** Scheduling state is a cache, never the truth. Any bug,
  any bad migration, any FSRS upgrade — replay the log.
- **The migration spike is built and verified against a real export** (§7.5): 1094
  vocabulary notes, 4504 reviews, three months of real history, read cleanly. Five
  real gaps between the original design and the actual file were found and fixed in
  the process — this is exactly the outcome step 0 was for, and it's done.

---

## 1. Why build this at all

### 1.1 The reasons that do not hold

Worth stating plainly so nobody re-litigates them later.

- **"Anki costs money."** It does not. Desktop is AGPL-3.0, AnkiDroid is GPL-3.0,
  AnkiWeb sync is free. The only fee anywhere is AnkiMobile on iOS, and this household
  is on Android.
- **"I want to stop depending on AnkiWeb."** Fair, but that is a config change, not a
  rewrite — Anki ships a self-hostable sync server and AnkiDroid accepts a custom
  endpoint. If that were the whole complaint, this project would not be justified.
- **"Anki is a simple program."** The reviewer is simple. Anki is not: a Rust core, a
  TypeScript reviewer, a Python/Qt desktop shell, a separate Kotlin Android app, a sync
  protocol, a template engine, and fifteen years of accumulated edge cases. Rebuilding
  *that* would be a multi-year mistake.

### 1.2 The reason that does hold

The pipeline is one-way and always has been:

```
bot  ─┐
      ├─► CSV / .apkg ─► AnkiDroid ─► (nothing)
scan ─┘
```

The bot's `flashcards` table is the proof:

```sql
CREATE TABLE "public"."flashcards" (
    "id" uuid, "user_id" uuid, "vocabulary_id" uuid,
    "example_message_id" uuid, "created_at" timestamptz
);
```

No `due`, no `stability`, no `lapses`, no review count. Every signal about what is
hard, what lapsed, and what stuck lives on a phone, inside an app that does not talk
back. `/recap` cannot know that a word keeps failing. `/learn` cannot know a word is
already mastered and stop re-adding it.

That is the capability being bought. Not a cheaper Anki — a **closed loop**.

### 1.3 The reason that makes it cheap

The note type in use is one card template, one direction, seven fields:

```
FRONT: {{lemma}}
BACK:  FrontSide + lemma_translation, gloss, part_of_speech,
       example, example_translation
```

No cloze, no reverse cards, no conditional sections, no image occlusion. The reviewer
being rebuilt is a `<div>` with one word in it, a tap, five more divs, and four buttons.
Anki's template engine is almost entirely unused.

---

## 2. Scope

### 2.1 Replaced

| Capability | Today | After |
|---|---|---|
| Daily review queue | AnkiDroid | PWA |
| Scheduling | FSRS in AnkiDroid | FSRS via a scheduler library, same parameters |
| Page scanning | Streamlit app → download → import | In-app, straight to the collection |
| Pronunciation | AnkiPA + Azure (English only) | Whisper-based, **works for Ukrainian** |
| Stats | Anki graphs | Read-only views over the review log |
| Sync | AnkiWeb | Append-only review log against Postgres |

### 2.2 Explicitly not replaced

**The Telegram bot pipeline does not change.** `/learn`, `/export`, `/pronounce`,
`/recap` keep working exactly as they do now. The bot keeps writing `vocabulary`/
`flashcards` rows exactly as before — nothing existing is removed or altered.

Revised 2026-09-16, against `anki_notes.source`'s own CHECK constraint (§5), which
already listed `'bot'` as a first-class value alongside `'scan'`/`'anki-import'`
by the time that table was designed — stronger, more specific evidence of intent
than this section's original sentence ("no change to `index.ts` is in scope"),
written before `anki_notes` existed as a concept. `annotateMessage` (capybara-bot's
`telegram-bot/index.ts`) now dual-writes: the same vocabulary it already upserts
into `vocabulary` also gets upserted into `anki_notes` with `source: 'bot'`, so it
becomes a real, independently-scheduled reviewable card in this app — not a
reconciliation job, not a second table capybara-anki reads, just one more `upsert`
call next to the one already there. `vocabulary`/`flashcards` themselves are
untouched by this — capybara-anki never reads them.

### 2.3 Kept forever

**`.apkg` export stays.** It costs nothing — it is already written and tested — and it
is both the backup format and the escape hatch. As long as a current collection can be
exported back into real Anki, this project is never a bet that cannot be walked back.

---

## 3. Decisions

Locked unless revisited deliberately.

| # | Decision | Rationale |
|---|---|---|
| D1 | Offline-first PWA | Matches how AnkiDroid is actually used — reviewing without signal. The single biggest driver of effort, and non-negotiable. |
| D2 | Cards shared, **scheduling identity lives on the review log** | `card_state` stays keyed on `note_id` alone — decks are disjoint by language today, so no interval is actually shared. `reviews.user_id` is the one column that has to exist, because it is the only place "who reviewed this" is unrecoverable later. If overlap ever happens, `card_state` splits by replaying the log — see §4.3, §5. Resolved 2026-09-15. |
| D3 | Migrate cards **and** review history | FSRS is on, so memory state ports directly. Mature cards stay mature. |
| D4 | Same Supabase project as the bot | One Postgres, so the feedback loop into `/recap` is later a join, not an integration. |
| D5 | One unified app, scanner included | Deletes the entire export/import surface. The reason the project is worth doing at all. |
| D6 | TypeScript for everything hosted | One language, one deploy target, one secret store. Reuses the Anthropic-from-Deno pattern already proven in the bot. |
| D7 | Python **only** for the migration CLI | Local tool, run a handful of times, never hosted. Gets the mature zip/SQLite/zstd stack for the one task where being wrong costs review history — and, verified 2026-09-15 (§7.5), gets to depend on the actual `anki` package for the one piece (deck options) that's a genuine protobuf blob in a real collection with no JSON fallback. A heavier dependency costs nothing here specifically because this stays local-only. |
| D8 | Image prep in the browser | Canvas resize before upload: ~1MB over mobile data instead of a 12MB camera original. Browsers apply EXIF orientation automatically, so the hand-rolled rotation goes away. |
| D9 | New third repo | Clean boundaries. Scanner and bot both feed it. |
| D10 | No ingest review step | Scan, extract, import. Fixing happens in the reviewer instead — see D11. |
| D11 | **Edit-in-place in the reviewer** | Consequence of D10. Without it there is no repair path at all — see §4.4. |
| D12 | Suspend / bury / delete mid-review | Cheap, and the first thing that gets reached for with LLM-generated cards. |
| D13 | Device token, delivered once as a URL fragment | `https://app/#t=<token>` on first open; the app reads `location.hash`, stores the token in IndexedDB, then clears the fragment. Same one-tap install as "no login," but RLS can require the token and the Supabase anon key alone is then useless — see §4.5. Resolved 2026-09-15. |
| D14 | Whisper scoring: right / close / wrong | Three buckets, honestly reflecting the precision the method has. |
| D15 | Parallel-run with AnkiDroid | Migration therefore must be **idempotent and re-runnable**, which constrains the schema. |
| D16 | Streamlit scanner stays alive until replaced | No capability gap during the build. |
| D17 | `card_state`/`reviews` key on `(note_id, card_kind)`, not `note_id` alone | Consequence of §11 item 5, resolved against a real export: `Capybara+`'s 244 notes really do produce two independently-scheduled Anki cards (recall + spelling), each with its own memory state. `card_kind` defaults to `'recall'` — every non-`Capybara+` note only ever has one row, so this is additive, not a rewrite. Resolved 2026-09-16. |
| D18 | Pronunciation notes are `notes` rows with `kind = 'pronunciation'`, reusing existing columns | §11 item 4, resolved against the same export: the real note type's fields (`TargetText`/`ReferenceAudio`/`Translation`/`Hint`) map directly onto `lemma`/`audio_url`/`lemma_translation`/`gloss` — no new note columns needed. `kind` (default `'vocab'`) is the one addition, and it's what the reviewer UI switches on to render a record-and-score screen instead of reveal-and-rate. Scoring (D14's three buckets) maps to an FSRS rating and goes through the exact same `reviews`/`card_state` machinery as any other card — pronunciation needed a different *input method*, not a different *scheduler*. Resolved 2026-09-16. |

### 3.1 Rules inherited from `capybara-bot`

The new app shares a Supabase project with the bot, so the bot's discipline applies:

- **No deploys without an explicit, in-the-moment request.** The maintainer runs every
  deploy. This has bitten before.
- **No Supabase changes** — migrations, SQL, dashboard — without the same explicit
  request. A migration for this app touches the live couple database.
- **No secrets in code or git.** Everything via environment, never hardcoded.
- **The repo is public.** No conversation content, no corpus content, no personal
  details. Code, docs and placeholders only.

---

## 4. Architecture

```
┌─ phone ────────────────────────────────┐
│  PWA (service worker + IndexedDB)      │
│   · due queue, cached offline          │
│   · audio cached offline               │
│   · review log queued when offline     │
│   · camera → canvas resize → upload    │
│   · mic → pronunciation attempt        │
└────────────┬───────────────────────────┘
             │ HTTPS (device token)
┌────────────▼───────────────────────────┐
│  Supabase edge functions (Deno / TS)   │
│   · /scan       → Claude vision        │
│   · /sync       → review log ingest    │
│   · /pronounce  → Whisper + scoring    │
│   · holds every API key                │
└────────────┬───────────────────────────┘
             │
┌────────────▼───────────────────────────┐
│  Postgres (shared with the bot)        │
│   notes · card_state · reviews         │
│   scheduler_config                     │
│   ← bot writes flashcards as today     │
└────────────────────────────────────────┘

┌─ laptop, run a handful of times ───────┐
│  Python CLI: read collection export,   │
│  emit notes + card_state + reviews     │
└────────────────────────────────────────┘
```

Static hosting: Cloudflare Pages or Vercel. Free tier, HTTPS and service workers work
out of the box. Supabase Storage can serve static files but it is the awkward path.

**Status: done, on GitHub Pages, not the two options above.** The awkward path turned
out to be an edge function (`app`), not Storage: `web/` was first deployed as its own
Supabase Edge Function serving files read from disk, which worked for `.js`/`.css` but
not `index.html` itself — Supabase silently rewrites any `text/html` edge-function
response to `text/plain` (confirmed against a real deployed function and Supabase's
own docs; not a bug, a stated platform limitation, since Edge Functions are designed
for APIs, not serving pages). That function is deleted. `web/` is now published by
`.github/workflows/pages.yml` to GitHub Pages instead — same free-tier/HTTPS/service-
worker properties this section predicted, just a different provider than the two
named. The one real consequence: `web/` and the Supabase project are now different
origins, so every real API call is cross-origin — `supabase/functions/_shared/cors.ts`
is what that required, applied to `sync`/`scan`/`pronounce` alike, and verified against
the live project with a real cross-origin `curl` (preflight and real responses both
carry `access-control-allow-origin`).

### 4.1 Why the scanner's Python dissolves

`claude_parser.py` does four jobs. Three of them move:

- **Image prep** → the browser. Gets simpler; EXIF handling largely disappears.
- **The Claude call** → an edge function. `MODEL`, `MAX_TOKENS`, the prompt and the tool
  schema are all data. The Anthropic TypeScript SDK exposes the same error classes the
  Python currently catches, so the five failure branches map one-to-one, and truncation
  detection is the same `stop_reason` check.
- **Schema validation** → wherever the call lives.
- **Reading Anki collections** → stays in Python, as the migration CLI (D7).

The real cost of the port is the **test suite**: a mocked-transport suite covering
truncated responses, rejected keys, server errors and rate limits, needing no API key
and no network. It ports to Deno's test runner, but that is a day spent re-earning
coverage that already exists. Budget for it; do not pretend it is free.

One honest regression: browsers cannot decode HEIC, PIL with `pillow-heif` can. Android
cameras produce JPEG, so this likely never bites — but it is the one capability lost.

**Status: done (step 5).** Built as predicted above, with one real correction: the
prediction was "the Anthropic TypeScript SDK exposes the same error classes," which
turned out true for the *errors* (`AuthenticationError`/`RateLimitError`/
`APIConnectionError`/… — confirmed by fetching and reading `@anthropic-ai/sdk@0.39.0`'s
actual `error.mjs` export list) but not for the *call shape*: this SDK version's
`Messages` class has no `.parse()`/structured-output helper the way the Python SDK's
newer surface does (confirmed the same way — its `messages.mjs` exports only
`create`/`stream`/`countTokens`). `src/scan/extract.ts` uses forced tool-use instead:
one JSON-schema tool definition, `tool_choice` forced to it, the response's
`tool_use` block read as the structured output. Same schema-strictness
(`additionalProperties: false`, a full `required` list) as the Python side's
pydantic model, same five failure branches, same truncation check ahead of looking
at content at all.

`src/scan/import.ts` is D10 made real: `importExtractedCards` turns a page's
extracted cards straight into `notes` rows via `Store.createNote`, no approval
step, reusing `validateNoteEdit` (D11's edit-in-place validator, §4.4) rather than
inventing separate import rules for the same "a card needs something on its front"
invariant — one bad card from a shaky OCR read is skipped, not fatal to the rest
of the page.

`supabase/functions/scan/index.ts` is the HTTP surface, same shape and same honest
gap as `sync/index.ts`: real routing, D13 auth (factored into `src/auth.ts` once
both edge functions needed the identical bearer-token check), and `createNote`
left as an explicit `PostgresStore` stub. `web/scan.html`/`scan.js` are D8's other
half: `createImageBitmap` (which applies EXIF orientation itself) plus a canvas
resize to the same 1568px edge and 0.85 JPEG quality `claude_parser.py` used,
entirely client-side, before the photo ever leaves the device.

Verified with Playwright against the demo server (a canned card stands in for the
real Claude call, which is unit-tested separately against a fake client in
`src/scan/extract.test.ts`): scan a photo → see it land → go back to the deck list
→ the deck's new-card count is one higher, proving the imported note is real and
immediately reviewable, not a display fiction. That run caught two real bugs:
`web/demo-server.ts`'s routing gate checked a bare `/scan` prefix, which also
matched the *static files* `/scan.html`/`/scan.js` and 401'd them; and pulling the
toolbar's shared color tokens into a new `theme.css` (used by both `index.html` and
`scan.html`) added a `.icon-btn { display: inline-block }` rule whose specificity
silently beat the `hidden` attribute's own default, so the back button stopped
disappearing on the deck-list screen. Both fixed and re-verified.

### 4.2 Why the review log is the sync primitive

The hard case for offline is not "no signal." It is **flaky** signal: half-sent batches,
duplicate submissions, an app killed mid-session, clock skew between phone and server.

Making reviews **append-only events with client-generated ids** collapses that entire
class of bug. Retries are idempotent upserts. A duplicate submission is a no-op. Two
devices never conflict, because a review is a fact about one person at one moment, not
a mutation of shared state.

This must be designed in from the first line. Bolting it onto a mutable `due` column
later is a rewrite.

### 4.3 Why `card_state` is a cache

`card_state` is derivable: replay `reviews` through FSRS and it reconstructs exactly.
It exists only so the due query is fast.

That property is the answer to the obvious objection — *what if my homegrown app eats
five years of review history?* It cannot, as long as the log is intact. A bad migration,
an FSRS version bump, a scheduling bug discovered in six months: delete `card_state`,
replay, correct again.

This is worth the extra table even though a mutable `due` column would work on day one.
Anki's real hidden value was never the scheduler; it was that the collection does not
rot. This is how that value gets replaced.

### 4.4 Why edit-in-place is not optional

D10 removes the ingest review step. D-nothing provides a Browse window. Without D11
there is **no way to fix a card** — only to delete it.

Walk it through: the model extracts a wrong-sense translation, which the bot's own
prompt has a whole paragraph fighting because it is the known failure mode. The card
lands. In the reviewer it can be suspended or deleted. Re-scanning the page runs the
same model over the same image and very likely reproduces the same error.

The fix is not a feature. Every field of a card is already being rendered in the
reviewer; make them editable in place. A text input and an `UPDATE`. It also happens
to be the same component that would later serve as a browse/edit surface if one is
ever wanted, so the feature cut in §3 comes back nearly free.

### 4.5 Why a device token rather than no auth

"No login" sounds like *protected by an unguessable URL*. With Supabase it is not: the
project URL and anon key ship inside the JavaScript bundle. Anyone who loads the page
has them. If row-level security is permissive enough for an unauthenticated app to read
cards, it is permissive for anyone who views source — to read, write and delete.

This matters more here than in most projects. The corpus is derived from two people's
private conversations. `PRIVACY.md` exists. The bot's `/bug` command is admin-only
specifically because the non-admin partner cannot judge where the text lands. A
world-readable collection would be the one soft spot in an otherwise careful system.

A device token preserves everything that was actually wanted — no login screen, no
magic links, no token expiry, works offline forever — and removes the hole.

**Mechanism, resolved 2026-09-15.** Installing is opening one link:
`https://app/#t=<token>`. The token rides in the URL *fragment* deliberately — the
fragment is never sent to the server on the initial request and is generally kept out
of server access logs, unlike a query string. On load the app reads
`location.hash`, writes the token into IndexedDB, and calls
`history.replaceState` to strip it from the visible URL so it does not linger in
browser history or get forwarded if the page is shared by accident. Every request
after that carries the token in a header; an edge function validates it before
touching Postgres, and RLS denies the anon role outright — so a leaked bundle (URL
and anon key are always public in a client-side app) yields nothing on its own.

Two tokens, not one, generated once and put in a password manager at setup: `TIM_TOKEN`
and `VIKA_TOKEN`. Each install link encodes which user it belongs to, which is how the
app knows who is reviewing without a login screen — see §5, `card_state`/`reviews`
being scoped by `user_id` resolved from the token, not typed in.

---

## 5. Data model

**Implemented, not a sketch** — `supabase/migrations/20260915210000_capybara_anki_schema.sql`
has the real DDL (foreign keys, checks, indexes); this section is the annotated summary.
**Applied 2026-09-16**, on an explicit, in-the-moment request — see that file's header.

Foreign keys point at `capybara-bot`'s existing `"public"."users"` table (D4: same
Supabase project), not a parallel identity system — a D13 device token resolves to
one of its two rows, and that's what "which user" means in every table below.

**Table names are prefixed `anki_`.** Found before ever applying anything (checking
the live project's actual schema first, not assuming): `"public"."notes"` was already
taken by capybara-bot's own unrelated `/remember`/`/pin` personal-notes feature.
`CREATE TABLE IF NOT EXISTS` against that name would have silently no-opped, leaving
this app's real notes table missing while the rest got created fine. Prefixed all
four tables, not just the one that collided, since a second undetected collision
wasn't a risk worth keeping once one had already turned up unannounced.

```sql
-- Shared pool. Both users see every note.
anki_notes (
  id            uuid primary key,
  anki_guid     text unique,      -- migration idempotency key (§7.2)
  lemma, gloss, lemma_translation,
  part_of_speech, language, example, example_translation,
  audio_url     text,
  source        text,             -- 'scan' | 'bot' | 'anki-import'
  -- Free-text label, not a foreign key to a decks table — Anki itself treats a
  -- deck as just a path string on a card, and nothing here needs more than
  -- that. Added after the fact (§5.2), once real AnkiDroid screenshots made
  -- "browse by deck" look core to how this is actually used, not a detail.
  deck          text default 'Ukrainian',
  -- D18, resolved against a real export: a Pronunciation note is an `anki_notes` row
  -- too (`kind = 'pronunciation'`), reusing lemma/audio_url/lemma_translation/
  -- gloss for TargetText/ReferenceAudio/Translation/Hint rather than a parallel
  -- table. D17: has_spelling marks a real `Capybara+` note, which produces a
  -- second, independently-scheduled Spelling card (anki_card_state.card_kind below).
  kind          text default 'vocab' check (kind in ('vocab', 'pronunciation')),
  has_spelling  boolean default false,
  created_at    timestamptz
);

-- One row per CARD, not per note — D17, resolved against a real export: a
-- Capybara+ note's real Anki data confirmed two independently-scheduled cards
-- (separate cards rows, separate revlog history), so folding them into one row
-- per note would silently merge two different memory states. card_kind defaults
-- to 'recall'; 'spelling' only exists for a note with has_spelling. A cache over
-- `anki_reviews` (§4.3), folded without regard to who reviewed — see D2. Correct as
-- long as a note is only ever reviewed by one person, which decks being disjoint
-- by language makes true today.
anki_card_state (
  note_id       uuid references anki_notes(id),
  card_kind     text default 'recall' check (card_kind in ('recall', 'spelling')),
  primary key (note_id, card_kind),
  due           timestamptz,      -- a real FSRS moment, not a day — see below
  stability     real,             -- FSRS memory state
  difficulty    real,             -- FSRS memory state
  state         smallint,         -- new | learning | review | relearning
  reps          integer,
  lapses        integer,
  -- Required to correctly resume scheduling, found while building
  -- src/fsrs/replay.ts: ts-fsrs derives elapsed time from this against the
  -- next review's timestamp, and ignores whatever elapsed_days/scheduled_days
  -- a resumed card carries — confirmed directly against the library, not
  -- assumed. Real Anki agrees: a card's own memory-state JSON carries the
  -- equivalent as "lrt" (last-review-time), found while reading a real
  -- export during the migration spike (§7.5) — this wasn't a guess either
  -- time.
  last_review   timestamptz,
  suspended     boolean,
  -- Denormalized from the fold, not authoritative: whichever user_id last
  -- appeared in `anki_reviews` for this note. Lets the reviewer filter "my due
  -- queue" without a join. If a note is ever reviewed by both users, this
  -- column stops meaning anything and anki_card_state must be split into a real
  -- (note_id, user_id) table by replaying `anki_reviews` — the escape hatch D2
  -- exists for. Nothing about `anki_reviews` itself has to change to do that.
  last_user_id  uuid references users(id)
);

-- Append-only. The sync primitive (§4.2). Never updated, never deleted.
anki_reviews (
  id            uuid primary key, -- client-generated → idempotent upsert
  note_id       uuid references anki_notes(id),
  card_kind     text default 'recall' check (card_kind in ('recall', 'spelling')),
  user_id       uuid references users(id),
  rating        smallint,         -- 1..4 — matches ts-fsrs's Rating enum exactly,
                                   -- which in turn matches Anki's own revlog.ease;
                                   -- no translation needed anywhere in the pipeline
  reviewed_at   timestamptz,      -- client clock, when it happened
  elapsed_days  integer,          -- recorded for audit/cross-check; NOT an input
                                   -- to replay — see anki_card_state.last_review above
  scheduled_days integer,
  ingested_at   timestamptz default now()  -- server clock, when it arrived
);

-- Per-person. Lifted verbatim from AnkiDroid at migration (§7.3). Verified real
-- values for one user, 2026-09-15: desired_retention 0.9, learning_steps {1,10}
-- (minutes — real numbers, hence real[] not integer[]), daily_new_limit 40,
-- daily_review_limit 200, max_interval 36500. fsrs_params was an empty array —
-- a real, meaningful state (§7.5), and ts-fsrs's generatorParameters() falls
-- back to its own built-in defaults for an empty or wrong-length array
-- (confirmed directly against the library), so the application layer never
-- needs to special-case it.
anki_scheduler_config (
  user_id           uuid primary key references users(id),
  fsrs_params       real[],
  desired_retention real,
  learning_steps    real[],
  daily_new_limit   integer,
  daily_review_limit integer,
  max_interval      integer
);
```

Two clocks on `reviews` is deliberate. `reviewed_at` is what FSRS needs — when the
recall actually happened. `ingested_at` is what debugging needs — when it reached the
server, which on a week-long offline stretch is very different.

### 5.1 `src/fsrs/replay.ts` — card_state is a fold, implemented

Built and tested (`src/fsrs/replay.test.ts`, Deno, `ts-fsrs`) rather than left as a
sketch, because §4.3's whole safety argument rests on one property: replaying a
note's full review history from nothing must reach the *exact* same state as
applying those same reviews one at a time, the way a live ingest path would. That's
not asserted, it's tested directly — build the state both ways, assert deep
equality — alongside determinism (no `enable_fuzz`, since replaying history is not
scheduling a future review) and order-independence (the fold sorts by `reviewed_at`
itself rather than trusting the caller).

`suspended` is deliberately outside this fold entirely — see the module's docstring.
Suspending a card is a UI action (D12), not something any rating history determines,
so replay never touches it; a caller merges the fold's output with whatever
`suspended` already is.

### 5.2 `src/review/` — the reviewer's server-side logic, step 2

Built and tested (`src/review/*.test.ts`, 42 tests) ahead of any UI, same order as
every other step in this build: get the logic right and verified first, wire a
surface onto it second. `web/` (below) is that surface.

**One real schema consequence, found while implementing suspend rather than
predicted in advance:** `card_state` can exist with every FSRS field null. §4.3
frames `card_state` as "a fold over reviews," which is true of the FSRS-derived
columns — but `suspended` isn't derived from reviews at all (§5.1), and a card can
be suspended *before* its first review, which means a row must be able to exist for
that purpose alone. `mergeCardState` (`mutations.ts`) is what makes this safe:
every action patches only the fields it has an opinion about, so a review after a
pre-emptive suspend doesn't invent stability out of nothing, and a suspend after a
real review doesn't touch the FSRS state already there.

**The due-queue order is a stated policy decision, not a port of Anki's own
algorithm** (`dueQueue.ts`'s docstring has the details): learning/relearning cards
due now, then review cards oldest-due-first, then new cards up to the day's
remaining allowance — each respecting `suspended` and "due now" but with no
attempt to reproduce Anki's v3 scheduler's gather/interleave settings. Deliberately
simple, and changeable later without touching the data model, since it only reads
already-public row shapes.

**`supabase/functions/sync/index.ts`** is the HTTP surface: `GET /sync/due`,
`POST /sync/review`, `POST /sync/suspend`, `PATCH`/`DELETE /sync/note/:id`. It is
real, complete routing and D13 bearer-token auth — and an explicitly unimplemented
`PostgresStore`. Every other external boundary in this build (the Anki reader, the
FSRS replay) was written against something concrete enough to test and had at least
one real assumption corrected by doing so (§7.5, this section's own finding above).
A `PostgresStore` written with no live project to run it against would skip that
step entirely; it's better written once, against a real project, than guessed at
twice.

**`web/`** is the reviewer UI — plain HTML/JS, no build step, since every bit of
scheduling logic lives server-side and the browser's whole job is fetch → render →
post an answer → next card. Verified by actually running it: `web/demo-server.ts`
serves the same JSON shapes `/sync` would, backed by `InMemoryStore` and placeholder
vocabulary notes (never real corpus content), and a full click-through — reveal,
rate, advance, edit, save, suspend — was driven with Playwright rather than left as
"should work." That run caught one real bug: `location.hash` includes its leading
`#`, which the token-capture code's `URLSearchParams` call didn't account for, so a
fresh install link never actually stored its token. Fixed and re-verified.

**Redesigned to match real AnkiDroid, once actual screenshots of it existed to copy
rather than guess at.** `web/index.html`'s CSS now uses AnkiDroid's own night-theme
palette (near-black surfaces at two elevations, the blue/red/green new-learning-
review convention, Again/Good/Easy solid-filled with Hard visually quieter) with a
light-mode inversion via `prefers-color-scheme`; `web/app.js` gained a deck-list
landing screen (one row per deck, its own three counts) in front of the review
screen, rather than dropping straight into one combined queue. This is also where
`notes.deck` (above) and `QueueSummary`/`getDeckSummaries` (`src/review/handlers.ts`)
came from — the schema had no deck concept until the redesign made "browse by deck"
look load-bearing rather than cosmetic. Only Ukrainian and English are shown, not
real AnkiDroid's full five-deck list: Grammar/Spelling/Pronunciation are different
card shapes entirely (§7.5 finding 5, §11), not a rendering gap.

Real AnkiDroid also shows, above each of the four rating buttons, the interval that
rating would produce ("<10m", "4.1mo") — a preview, not a commitment, computed by
running the scheduler forward without saving the result. `previewIntervals`
(`src/review/mutations.ts`) is exactly that: `applyReview` is already pure, so
calling it four times against the same starting state and keeping all four results
(instead of one) is the whole implementation, with a null-safe path for a
never-reviewed card (`toFsrsCardState`'s guard, hardened by a test that found it
crashing on a hand-built partially-null row rather than treating it as "new").
`getDueQueueWithPreviews` (`handlers.ts`) attaches one to each due card in the same
response that carries its content, so `web/app.js` renders both without a second
round trip; this replaced a `buildDueQueueResponse` that had been separately
duplicated in `supabase/functions/sync/index.ts` and `web/demo-server.ts`.

---

## 6. Offline behaviour

**Status: done.** `web/offline.js` (IndexedDB) + `web/sw.js` (service worker),
wired through `web/app.js`'s `api()` — see §6.2 below.

| Situation | Behaviour |
|---|---|
| Online, normal | Answer posts immediately, `card_state` updated server-side |
| Offline | Review appended to a local queue in IndexedDB, `card_state` updated locally so the session continues |
| Reconnect | Queue flushes as a batch; server replays through FSRS |
| Partial flush | Client-generated ids make the retry a no-op for whatever already landed |
| App killed mid-session | Queue is durable in IndexedDB; nothing is lost |
| Two devices, both offline | No conflict — the two users review disjoint decks (§9.1), and reviews are events, not mutations |

Audio is the bulk of offline storage and needs an explicit caching policy — see §11.

### 6.1 What "card_state updated locally" turned out to mean

The original sketch above implied client-side FSRS scheduling while offline. Built
narrower than that, deliberately: `web/` has no build step (§5.2), and `ts-fsrs`
has no CDN-friendly browser build to import without one, so replaying FSRS
client-side would mean either a build step this repo doesn't have or a second,
hand-written scheduler implementation drifting from `src/fsrs/replay.ts` — exactly
the kind of untested duplicate logic this whole build has avoided everywhere else.

What's actually needed for "the session continues" turns out not to require it: a
due queue is fetched once per deck entry, complete with every card's four-button
interval preview (§5.2) computed *before* anything goes offline. Advancing through
that already-fetched queue while offline needs no new scheduling math — only
`card_state`'s *eventual* value depends on FSRS, and that's exactly what the queued
review (replayed by the real server-side FSRS on reconnect, §4.3) still produces
correctly. The one accepted rough edge: if the app is killed and reopened while
still offline, the reloaded due queue comes from the IndexedDB cache taken *before*
those offline reviews, so an already-answered card can be re-offered. Answering it
again isn't wrong, just an extra real review event — reviewing the same card twice
in one disconnected stretch is a harmless event, not a lost or corrupted one (§4.2).

### 6.2 What's built

- **`web/offline.js`** — two IndexedDB object stores: `pendingReviews` (reviews
  submitted while offline, keyed by the client-generated `reviewId` so a duplicate
  queue attempt is a no-op) and `cachedResponses` (the last good response for every
  GET the app makes, keyed by path+query). Deliberately scoped to *reviews only* —
  suspend/edit/delete aren't queued; each fails visibly if attempted offline rather
  than queuing a mutation that could race a review of the same note.
- **`web/app.js`'s `api()`** is the single point that decides when to fall back:
  a `TypeError` from `fetch` (not a real non-2xx response, which still propagates)
  means offline, at which point a queued `POST /sync/review` returns as if it
  succeeded and a failed `GET` returns its last cached value instead of throwing.
  Every call site (`submitRating`, `refreshStatsStrip`, `enterDeck`, …) is offline-
  safe automatically as a result, rather than each needing its own try/catch.
- **`flushPendingReviews()`** runs on the browser's `online` event and once at
  startup if already online (covers the "closed the tab while offline, reopened it
  online later" case) — posts each queued review in order, stopping at the first
  failure rather than reordering around it, and refreshes the stats strip once done.
- **A pending-sync count** (`⟳ N`) in the stats strip, so "did my answer actually
  reach the server" is never silent — verified visually with Playwright: appears
  after an offline answer, disappears once `online` fires and the flush completes.
- **`web/sw.js`** caches the static shell (`index.html`, `app.js`, `offline.js`)
  cache-first, and explicitly never intercepts `/sync/*` — API freshness is
  `offline.js`'s job, not something to fake with an HTTP cache. Verified with
  Playwright: a full page reload while offline (`context.setOffline(true)`) still
  renders the deck list, sourced from IndexedDB's cached `/sync/decks` response.

---

## 7. Migration

**Build this first (§9).** It is the only step that can prove the project impossible.

**Status: done. Verified against a real AnkiDroid export, 2026-09-15.** Everything
in this section was written before that verification and has been corrected in
place rather than kept as a separate "what we predicted" record — §7.5 has the
findings that actually changed something, for anyone who wants the diff between the
plan and reality.

### 7.1 What is being read

A collection export is a zip containing a SQLite database, which the container-name
guess in the original draft got right on the first try: `collection.anki21b`,
zstd-compressed. What the original draft got wrong turned out to be everything
*inside* that database, not the container — see §7.5.

### 7.1a The bigger discovery: which Anki this is matters more than which file format

The container format was a one-time guess to verify. What actually needed verifying
— and didn't hold — was the assumption that a collection database looks like the
one this repo's own scanner produces via genanki. It doesn't, not anymore. A real,
current AnkiDroid export is Anki's post-Rust-rewrite schema: note-type definitions
and deck options have moved out of the JSON blobs (`col.models` / `col.decks` /
`col.dconf` — all **empty strings** in a real file) this design originally assumed,
into dedicated tables, with deck options specifically stored as a **protobuf blob**.
There is no hand-rolled way to decode that which doesn't silently break on the next
Anki release, so the migration CLI reads through Anki's own `anki` library —
opened against a throwaway copy, never the real file — rather than a bare
`sqlite3.Connection`. See `migration/reader.py`'s docstring for the full mechanics.

### 7.2 Idempotency

D15 means migrating at least twice — once to try it, once at the real cutover. So
migration must never duplicate a card or clobber newer scheduling state.

The key is Anki's note GUID, which is stable across exports. Store it on `notes`, key
on it, and re-running becomes safe by construction.

This repo already solved the same problem once, in the other direction: note identity
is derived from lemma + part-of-speech rather than hashing every field, precisely so a
re-export updates a note instead of importing a second one.

### 7.3 What to extract beyond cards

FSRS being enabled means each card carries memory state that ports directly. Equally
important, and easy to forget:

- the FSRS parameter vector — **read its length from the collection, do not assume a
  count; it varies by FSRS version**
- desired retention
- learning steps
- daily new and review limits
- maximum interval

Those five settings *are* the felt experience of a day's reviews. Perfect card data with
wrong limits will feel wrong.

**Verified values, real collection, 2026-09-15:** desired retention `0.9`, learning
steps `[1, 10]` (minutes), daily new limit `40`, daily review limit `200`, max
interval `36500` days. The FSRS parameter vector is an **empty list** — see §7.5,
this is a real, meaningful state (FSRS is on and scheduling cards, but "Optimize"
has never been run), not a missing value.

### 7.4 Output

The CLI does not write to Postgres. It emits files, and prints a report: how many notes,
how many cards, date range of the review log, anything it could not parse. Reading is
separable from writing, and the first run should be a read-only question — *what is
actually in here?* — not a mutation of the live couple database.

### 7.5 Everything else the real export changed

Five findings, each one a place the original design (written before any real file
existed) was wrong in a way only a real file could surface — which is the entire
argument for building this step first, per §9.

1. **The zstd frame has no content-size header.** Anki streams the compress rather
   than doing a one-shot with a known length, so `ZstdDecompressor.decompress()`
   fails with "could not determine content size in frame header" on a real file
   despite passing every test against a synthetic one that used the easier form.
   Fixed with a streaming reader (`reader.py`); the test fixture builder now
   reproduces the real framing so this can't quietly regress.

2. **The vocabulary note type's field order is not what the scanner's own
   `APKG_FIELDS` says.** `anki_package.py` lists `lemma_translation` third; the real
   collection has it **last**. Trusting the scanner's own constant instead of the
   file would have rejected every real note. Ground truth wins — `transform.py`'s
   `EXPECTED_FIELDS` now matches the file, not the other repo.

3. **There are two note-type names carrying the same vocabulary schema** —
   "Capybara" (850 notes) and "Capybara+" (244 notes), the latter apparently a
   deliberate later revision (see finding 5, not an accidental duplicate). Matching
   by name would silently drop whichever wasn't hardcoded. Recognition is by field
   *signature* now, not name — see `transform.py`'s module comment.

4. **Deck names aren't stored the way they display.** The `decks.name` column holds
   path components joined by `\x1f` (the same separator note fields use), not
   literal `::` — a raw-SQL read gets `Capybara\x1fUkrainian`, which prints as the
   invisible-character mess `CapybaraUkrainian` in a terminal and is easy to miss
   entirely. Reading deck names through the Anki library (`col.decks.all_names_and_ids()`)
   resolves this correctly; `get_deck_names()` in `extract.py` does that rather than
   reading the column directly.

5. **"Capybara+" isn't a name variant — it has a second card template.** `Capybara`
   has one template (`Card 1`); `Capybara+` has two (`Card 1` and `Spelling`), which
   is presumably what feeds the separate `Capybara::Spelling` deck. §1.3's "one card
   template, one direction" description is true of the *original* note type and no
   longer true of the collection as a whole — 244 notes produce two cards apiece,
   each independently scheduled (confirmed for real against a second export,
   2026-09-16: 178+66=244 recall cards split across `Capybara::Ukrainian`/`English`,
   and all 244 spelling cards in `Capybara::Spelling`). **Resolved as D17**: the
   reviewer surfaces both as separate due items via a `card_kind` dimension on
   `card_state`/`reviews`, not folded into one row.
   **The migration CLI does not implement this yet — a real, currently-live bug,
   not just an unresolved question anymore.** What's described in the paragraph
   this replaced (pick the lower-id card for `card_state`, attach every card's
   review history to that one row) actively corrupts a `Capybara+` note's data:
   the Spelling card's reviews get recorded against the recall card's `card_state`,
   so an FSRS replay of that merged log won't match either card's real memory
   state. Needs `cards.ord` (not currently selected by `extract.get_cards`) to
   assign `card_kind` correctly before this collection can be migrated for real —
   see §8's "known gap" note.

None of the five needed a redesign. All five were fixed in the code they touched,
with a comment or a test (often both) explaining what broke and why, so nobody
re-discovers them from a stack trace six months from now.

Full real counts, for scale, and as a sanity check anyone re-running this against a
newer export can compare against: **1094 vocabulary notes** read cleanly (204
pronunciation-practice notes correctly excluded, 0 unexpected skips), **1034 of
1094 cards carry FSRS memory state** (the remainder are new/unreviewed), **1
suspended card**, **4504 reviews** spanning 2026-06-10 to 2026-09-12.

---

## 8. Pronunciation

This is the one place the new app **beats** Anki rather than matching it.

AnkiPA is a client for Azure Pronunciation Assessment. Azure has no `uk-UA` phoneme
model, so Ukrainian cannot be scored there at all — and that is half the household.
(`ru-RU` is on Azure's list and is deliberately not a substitute: different phoneme
inventory, so the scores would be noise.)

Not being bound to Azure means Whisper transcription compared against the target text
gives a real signal for Ukrainian today. Cruder than phoneme assessment — which is why
the output is **three buckets, not a percentage** (D14). A 0–100 number would imply a
precision transcription-versus-target does not have.

The existing `scripts/anki_pronunciation/` in the bot repo already generates reference
audio via ElevenLabs. That stays as-is; only the scoring side is new.

**Status: done**, once open questions 4 and 5 (§11) were resolved against a second
real export (2026-09-16, structural fields/counts only — no corpus content read or
retained) — see D17 and D18. The real findings corrected one assumption rather than
confirming it: `Capybara::Grammar` turned out to be plain vocabulary notes (nothing
to build), but `Capybara::Pronunciation::Ukrainian` genuinely does **not** share the
vocabulary schema — its note type (`Capybara Pronunciation (shadowing)`, fields
`TargetText`/`ReferenceAudio`/`Translation`/`Language`/`Hint`/`SourceId`) is
different, just close enough to reuse `notes`' existing columns (D18) rather than
needing a parallel table.

**`src/pronunciation/score.ts`** — D14's three buckets, computed as normalized
Levenshtein distance between a Whisper transcript and the note's target text
(`lemma`), lowercased and punctuation-stripped first. Deliberately crude, per D14's
own rationale: a real phoneme assessment would score pronunciation; this only
confirms Whisper heard roughly the right words. Maps to an FSRS rating — `right`→3
(Good), `close`→2 (Hard), `wrong`→1 (Again) — **never 4 (Easy)**, since a string-
similarity check can't earn that confidence. 7 tests.

**`src/pronunciation/transcribe.ts`** — calls OpenAI Whisper (`whisper-1`,
`audio/transcriptions`, `FormData` with `file`/`model`/`response_format:
"verbose_json"`/an optional `language` hint) — the exact same call
`capybara-bot`'s own voice-message handling already makes, reused rather than
reinvented. 4 tests against a fake `TranscribeClient`, never a real network call.

**`supabase/functions/pronounce/`** — `POST /pronounce/score` transcribes and
scores an attempt, returning `{ transcript, similarity, bucket, rating }`, and
writes nothing itself: the client takes that `rating` to the exact same
`POST /sync/review` every other card uses (`cardKind: 'recall'` — a pronunciation
note never has a spelling card), so there's one path that ever mutates
`card_state`, not two. Same honest `PostgresStore`-not-implemented gap as `/sync`
and `/scan`.

**`web/app.js`** — a pronunciation note (`note.kind === 'pronunciation'`) gets a
record-and-score screen instead of reveal-and-rate: a mic button using
`MediaRecorder`, a scoring spinner, then the bucket/transcript with a Continue
button that calls the normal rating-submission path. Verified with Playwright
using Chromium's fake media device (`--use-fake-device-for-media-stream`/
`--use-fake-ui-for-media-stream`) against the demo server, whose `/pronounce/score`
returns a real `scoreAttempt()` call fed a canned "perfect" transcript rather than
a real Whisper call — full record → score → continue → next-card cycle confirmed
working, not just the individual pieces.

**Known gap, not silently missed: `migration/` (the Python CLI) does not yet
implement D17/D18.** `transform_note` still recognizes only the plain vocabulary
field signature and would skip every Pronunciation note and mis-key every
`Capybara+` note's second card. Fixing it means: recognizing the Pronunciation
field signature and mapping it onto `notes`' columns (with `Language`'s value —
a BCP-47 tag like `uk-UA` per `scripts/anki_pronunciation/deck.py` in the bot
repo — normalized to `uk`/`en`, preferably corroborated against the deck path
rather than trusted blindly); reading `cards.ord` (not currently even selected by
`extract.get_cards`) to know which of a `Capybara+` note's two real cards is
`recall` and which is `spelling`; and setting `notes.deck` from the *recall*
card's deck specifically, since the spelling card's own real Anki deck
(`Capybara::Spelling`) is deliberately not modeled as a separate deck here (D17 —
spelling surfaces as a second due item in the note's own deck, not a new one).
This needs the same "verify against the real export, add a regression test" pass
§7.5 gave the original five findings before it's built, not a guess.

### 8.1 Stats — the other half of step 6, and separable from pronunciation

**Status: done.** Unlike pronunciation, this needed no open question resolved: it
reads only `reviews` and `card_state`, both already fully specified. `src/review/
stats.ts` computes, over already-fetched rows (same split as `dueQueue.ts`):

- **A day-by-day activity histogram**, zero-filled so a quiet day is a real zero,
  not a missing bar — `reviewsByDay`.
- **All-time success rate** — the fraction of reviews rated anything but Again.
  `null` (not `0`) with zero reviews ever, since "no data yet" and "0% success"
  are different things a screen should say differently.
- **Current streak** — consecutive days with at least one review, walking back
  from today. Not having reviewed yet *today* doesn't break a streak that's still
  active; only a missed prior day does.
- **Collection composition** (`StateCounts`) — new/learning/review/suspended
  counts across every note, independent of what's due today. `suspended` overlaps
  the other three rather than excluding from them, matching how `dueQueue.ts`
  already treats suspension as orthogonal to scheduling state everywhere else.

`handlers.ts`'s `getStats` fetches all-time reviews in one round trip (`since` the
epoch) and lets the histogram's own bucketing drop whatever falls outside its
window — one fetch does double duty for both the windowed chart and the all-time
numbers, rather than two queries. `GET /sync/stats?days=N` (`supabase/functions/
sync/`) and `web/stats.html`/`stats.js` (a hand-rolled stacked-bar chart, no
charting library — this is the one part of `web/` genuinely free to add a
dependency and still doesn't need one) round it out. 12 tests. Verified with
Playwright against the demo server, seeded with six backdated synthetic reviews
purely to give the chart/streak/success-rate real shapes on first load rather
than an all-zero screen.

---

## 9. Build order

Scope is everything-at-once. Order still matters, because the ordering is what makes
the risk survivable.

| Step | What | Why here |
|---|---|---|
| **0** | Migration spike — read an export, print a report | **Done, verified against a real export (§7.5).** |
| **1** | Schema + review log + FSRS replay, server-side | **Done.** Schema in `supabase/migrations/` (unapplied); replay in `src/fsrs/` (§5.1), tested including the replay-equals-incremental property. |
| **2** | Reviewer: due queue, four buttons, suspend/delete, **edit-in-place**, decks, interval previews | **Done.** Logic in `src/review/` (§5.2, 42 tests), HTTP surface in `supabase/functions/sync/` (routing + auth complete, `PostgresStore` not yet — needs a live project), UI in `web/` redesigned to match real AnkiDroid's night theme (verified end-to-end with Playwright against a local demo server). Not deployed. |
| **3** | Offline: service worker, IndexedDB, queued reviews | **Done.** `web/sw.js` + `web/offline.js` (§6.2), verified with Playwright: an offline answer queues and shows a pending count, a reconnect flushes it, and a full page reload while offline still renders the cached deck list. Turns it into something that replaces AnkiDroid rather than supplements it. |
| 4 | Real migration, run for real | Blocked on a live Supabase project with this schema applied — Claude never deploys or touches Supabase without an explicit, in-the-moment request (capybara-bot's CLAUDE.md, this repo's own ground rules), so this waits for the maintainer. |
| **5** | Scanner: camera, canvas resize, `/scan` edge function | **Done.** `src/scan/` (extract + import, §4.1, 13 tests), `supabase/functions/scan/`, `web/scan.html`/`scan.js`, verified end-to-end with Playwright against the demo server. Deletes the export/import tax (§1.2). |
| **6** | Pronunciation, stats | **Done, both halves.** Stats (§8.1, 12 tests). Pronunciation (§8, `src/pronunciation/`, `supabase/functions/pronounce/`, 11 tests) once open questions 4/5 (§11) were resolved against a real export — Grammar needed nothing, Pronunciation got D18's field-reuse mapping, Spelling got D17's `card_kind`. `migration/`'s Python CLI does not yet implement either — a known, flagged gap (§8), not silently missed. |

Step 0 was the whole point of doing this first: a day of work that either de-risks the
project or saves a month. It found five real gaps between plan and reality (§7.5) and
none of them were fatal — the project is not stopping.

---

## 10. Non-goals

Stated so they do not creep in:

- **Multi-tenant.** Two users, one database, same as the bot.
- **A Browse window.** Edit-in-place (§4.4) is the repair path.
- **Anki's template engine**, cloze, image occlusion, reverse cards. Unused today.
- **Add-on support.** No plugin API, ever.
- **Replacing AnkiWeb sync generally.** Sync here is one household's review log, not a
  general-purpose collection merge. This is why it is tractable.
- **Changing the Telegram bot.** §2.2.
- **Desktop-first anything.** The phone is the review surface.

---

## 11. Open questions

Not blocking the migration spike; blocking step 1.

1. **Audio offline caching.** Reference recordings are the bulk of storage. Cache every
   card's audio, only due cards, or fetch on demand and accept silence offline? Needs a
   size estimate against the current collection before deciding.
2. **Backfilling the bot's existing rows — going-forward half resolved 2026-09-16,
   backfill half still open.** New vocabulary the bot captures from here on writes
   to `anki_notes` too (§2.2, `source: 'bot'`) — settled. What's still open: the
   ~11,300 `vocabulary` rows and 776 `flashcards` rows that already existed before
   this change. Turning those into `anki_notes` rows would mean deciding how to
   seed their `card_state` (no FSRS history to replay — `flashcards` never
   recorded any, per §1.2), and would instantly hand both users thousands of new
   cards against a 40/day limit — months of backlog on day one. Left alone for now;
   a real decision, not an oversight.
3. **Day boundaries.** Both users are in one timezone but review at very different
   hours. Anki uses a configurable "next day starts at" rollover. What is it set to
   today, and does the same value carry over?
4. **What `language` means for queue filtering — resolved 2026-09-16, against a real
   export.** Inspected the actual collection (`migration/`'s own tooling, structural
   fields/counts only — no corpus content read or retained): `Capybara::Grammar`
   (61 cards) uses the plain `Capybara` note type, same `lemma`/`gloss`/… fields as
   every other vocabulary card — it's just a deck label, no schema question at all.
   **`Capybara::Pronunciation::Ukrainian` (191 cards) does NOT share the vocabulary
   schema** — this corrects an earlier assumption. Its note type,
   `Capybara Pronunciation (shadowing)`, has entirely different fields
   (`TargetText`, `ReferenceAudio`, `Translation`, `Language`, `Hint`, `SourceId`)
   and a single `Listen and Speak` template. See D18.
5. **The `Capybara+` second card template — resolved 2026-09-16, against the same
   export.** Confirmed: 244 `Capybara+` notes each produce two independently
   scheduled Anki cards — a normal recall card (178 in `Capybara::Ukrainian`, 66 in
   `Capybara::English` — same `Card 1` template as plain `Capybara` notes) and a
   `Spelling` card (all 244, in the dedicated `Capybara::Spelling` deck). Real Anki
   schedules these two cards independently (separate `cards` rows, separate revlog
   history) — folding them into one `card_state` per note would silently merge two
   different memory states into one. See D17: in scope for v1, via a new
   `card_kind` dimension rather than a fold.

Resolved since first draft: repo name is `capybara-anki` (created, not
`capybara-cards` as originally proposed).

---

## 12. Risks

| Risk | Severity | Mitigation |
|---|---|---|
| Collection export cannot be read or parsed | ~~Project-ending~~ **Retired 2026-09-15** | Step 0 found it readable; see §7.5 for what needed fixing along the way |
| Homegrown app loses review history | High | Append-only log (§4.3); `.apkg` export kept forever (§2.3) |
| Offline sync bugs eat reviews silently | High | Client-generated ids, durable IndexedDB queue, idempotent ingest |
| Scheduling feels subtly wrong after the switch | Medium | Port all five config values, not just card data (§7.3) |
| Bad cards accumulate with no repair path | Medium | D11, edit-in-place |
| Collection exposed publicly | Medium | D13, device token (§4.5) |
| Project stalls half-built, leaving nothing usable | Medium | Build order (§9) — usable at step 2, replaces AnkiDroid at step 3 |
| A migration breaks the live couple database | High | CLI emits files, never writes (§7.4); no Supabase changes without explicit request (§3.1) |

### What would make us stop

If step 0 shows the collection cannot be read reliably, or that FSRS memory state is not
recoverable — stop. The fallback is not a rewrite: it is self-hosting Anki's sync server
and periodically importing an export into Postgres for the feedback loop, which delivers
§1.2's actual goal for a fraction of the work.

**This did not happen.** Step 0 is done: the collection reads cleanly, 1034 of 1094
cards carry real FSRS memory state, and every gap between the plan and the real file
(§7.5) was a fix in the code that touched it, not a reason to reconsider the
approach. Step 1 is unblocked.

---

## Appendix — what this deletes from the scanner

For scale, the parts of this repo that exist **only** because Anki is a separate app:

- Timestamped filenames, to dodge Android Chrome's "Download file again?" dialog
- Two export buttons, because AnkiDroid registers for `.apkg` but not `text/csv`
- Deterministic note-type and deck ids, to avoid accumulating `Capybara-a3f1` copies
- Quoting every field so a lemma beginning with `#` is not eaten as an import directive
- Collapsing newlines, because Anki reads one note per line
- Overriding genanki's field-hash note identity with lemma + part-of-speech

None of it is wasted work — it is all correct, and it is all load-bearing today. It is
just tax on handing files to a program that cannot be changed. When the scanner writes
rows instead of files, all of it goes away.
