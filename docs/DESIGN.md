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
- **Build the migration spike first**, before any UI. It is the only step that can prove
  the whole idea impossible, it depends on none of the other decisions, and it is a day
  of work.

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
`/recap` keep working exactly as they do now. The bot keeps writing `flashcards` rows;
the new app simply also reads them. No change to `index.ts` is in scope.

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
| D2 | Cards shared, **scheduling per-person** | Two people's memories cannot share one interval. One pool of notes, `(note_id, user_id)` scheduling. Costs one column. |
| D3 | Migrate cards **and** review history | FSRS is on, so memory state ports directly. Mature cards stay mature. |
| D4 | Same Supabase project as the bot | One Postgres, so the feedback loop into `/recap` is later a join, not an integration. |
| D5 | One unified app, scanner included | Deletes the entire export/import surface. The reason the project is worth doing at all. |
| D6 | TypeScript for everything hosted | One language, one deploy target, one secret store. Reuses the Anthropic-from-Deno pattern already proven in the bot. |
| D7 | Python **only** for the migration CLI | Local tool, run a handful of times, never hosted. Gets the mature zip/SQLite/zstd stack for the one task where being wrong costs review history. |
| D8 | Image prep in the browser | Canvas resize before upload: ~1MB over mobile data instead of a 12MB camera original. Browsers apply EXIF orientation automatically, so the hand-rolled rotation goes away. |
| D9 | New third repo | Clean boundaries. Scanner and bot both feed it. |
| D10 | No ingest review step | Scan, extract, import. Fixing happens in the reviewer instead — see D11. |
| D11 | **Edit-in-place in the reviewer** | Consequence of D10. Without it there is no repair path at all — see §4.4. |
| D12 | Suspend / bury / delete mid-review | Cheap, and the first thing that gets reached for with LLM-generated cards. |
| D13 | Device token, not a login | Set once at install, lives in IndexedDB. Zero daily friction, works offline forever, and the collection is not world-readable — see §4.5. |
| D14 | Whisper scoring: right / close / wrong | Three buckets, honestly reflecting the precision the method has. |
| D15 | Parallel-run with AnkiDroid | Migration therefore must be **idempotent and re-runnable**, which constrains the schema. |
| D16 | Streamlit scanner stays alive until replaced | No capability gap during the build. |

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
magic links, no token expiry, works offline forever — and removes the hole. Paste a
secret once at install, store it in IndexedDB, send it with every request, validate it
at the edge function.

---

## 5. Data model

Sketch, not final. Column types elided where obvious.

```sql
-- Shared pool. Both users see every note.
notes (
  id            uuid primary key,
  anki_guid     text unique,      -- migration idempotency key (§7.2)
  lemma, gloss, lemma_translation,
  part_of_speech, language, example, example_translation,
  audio_url     text,
  source        text,             -- 'scan' | 'bot' | 'anki-import'
  created_at    timestamptz
);

-- Per-person. Never shared. A cache over `reviews` (§4.3).
card_state (
  note_id       uuid,
  user_id       uuid,
  due           date,
  stability     real,             -- FSRS memory state
  difficulty    real,             -- FSRS memory state
  state         smallint,         -- new | learning | review | relearning
  reps          integer,
  lapses        integer,
  suspended     boolean,
  primary key (note_id, user_id)
);

-- Append-only. The sync primitive (§4.2). Never updated, never deleted.
reviews (
  id            uuid primary key, -- client-generated → idempotent upsert
  note_id       uuid,
  user_id       uuid,
  rating        smallint,         -- 1..4
  reviewed_at   timestamptz,      -- client clock, when it happened
  elapsed_days  integer,
  scheduled_days integer,
  ingested_at   timestamptz default now()  -- server clock, when it arrived
);

-- Per-person. Lifted verbatim from AnkiDroid at migration (§7.3).
scheduler_config (
  user_id           uuid primary key,
  fsrs_params       real[],
  desired_retention real,
  learning_steps    integer[],
  daily_new_limit   integer,
  daily_review_limit integer,
  max_interval      integer
);
```

Two clocks on `reviews` is deliberate. `reviewed_at` is what FSRS needs — when the
recall actually happened. `ingested_at` is what debugging needs — when it reached the
server, which on a week-long offline stretch is very different.

---

## 6. Offline behaviour

| Situation | Behaviour |
|---|---|
| Online, normal | Answer posts immediately, `card_state` updated server-side |
| Offline | Review appended to a local queue in IndexedDB, `card_state` updated locally so the session continues |
| Reconnect | Queue flushes as a batch; server replays through FSRS |
| Partial flush | Client-generated ids make the retry a no-op for whatever already landed |
| App killed mid-session | Queue is durable in IndexedDB; nothing is lost |
| Two devices, both offline | No conflict — the two users review disjoint decks (§9.1), and reviews are events, not mutations |

Audio is the bulk of offline storage and needs an explicit caching policy — see §11.

---

## 7. Migration

**Build this first (§9).** It is the only step that can prove the project impossible.

### 7.1 What is being read

A collection export is a zip containing a SQLite database. Modern Anki compresses it
(`collection.anki21b`, zstd) rather than shipping plain SQLite. This repo's existing
test suite already unzips an `.apkg` and reads its SQLite the way Anki would — but that
is the *older uncompressed* format genanki produces. A real phone export will likely
need a decompression step, or Anki's "support older Anki versions" export option.

**Verify against an actual export before promising anything here.** This is the single
largest unknown in the document.

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

### 7.4 Output

The CLI does not write to Postgres. It emits files, and prints a report: how many notes,
how many cards, date range of the review log, anything it could not parse. Reading is
separable from writing, and the first run should be a read-only question — *what is
actually in here?* — not a mutation of the live couple database.

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

---

## 9. Build order

Scope is everything-at-once. Order still matters, because the ordering is what makes
the risk survivable.

| Step | What | Why here |
|---|---|---|
| **0** | Migration spike — read an export, print a report | Only step that can prove the idea impossible. Depends on no other decision. One day. |
| 1 | Schema + review log + FSRS replay, server-side | The durability property (§4.3) has to exist before anything writes reviews. |
| 2 | Reviewer: due queue, four buttons, suspend/delete, **edit-in-place** | The daily loop. Usable at this point, online-only. |
| 3 | Offline: service worker, IndexedDB, queued reviews | Turns it into something that replaces AnkiDroid rather than supplements it. |
| 4 | Real migration, run for real | Now there is somewhere for the data to land. |
| 5 | Scanner: camera, canvas resize, `/scan` edge function | Deletes the export/import tax (§1.2). |
| 6 | Pronunciation, stats | Genuinely separable; neither blocks daily use. |

Step 0 before anything else is the whole point. A day of work that either de-risks the
project or saves a month.

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
2. **Backfilling the bot's existing rows.** Do historical `flashcards` rows become
   `notes`, or only new ones from the switch forward? Affects whether migration has two
   sources to reconcile or one.
3. **Day boundaries.** Both users are in one timezone but review at very different
   hours. Anki uses a configurable "next day starts at" rollover. What is it set to
   today, and does the same value carry over?
4. **What `language` means for queue filtering.** The decks are effectively disjoint by
   language (§9.1 assumption), but that is an assumption, not a constraint — nothing
   currently stops a note being relevant to both users.
5. **Repo name.** `capybara-cards` is proposed, to sit alongside `capybara-bot`. Not
   locked.

---

## 12. Risks

| Risk | Severity | Mitigation |
|---|---|---|
| Collection export cannot be read or parsed | **Project-ending** | Step 0, before anything else is built |
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
