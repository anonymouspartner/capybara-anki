# Migration — retiring AnkiDroid

**Status: Phase 0.1 done, gate passed. Phase 1 done, live. Phase 2/3's loader is
built and verified against the real recovery export; the load itself is the one
step left to a maintainer, since it needs the service-role key (§6.3). Phase 4
done. Phase 5 done. Written 2026-09-18, against the live database and two real
exports — every number below was measured, not estimated. See the Appendix for
how to re-measure any of them.**

`docs/DESIGN.md` is the plan of record for *what this app is*. This document is
narrower and more urgent: it is the plan for **the day AnkiDroid gets
uninstalled**, and the list of things that are not true yet but have to be first.

---

## 0. TL;DR

- The app is live, both people are reviewing in it, and the reviewer itself is in
  good shape. That is not what stands in the way.
- **AnkiDroid held the only copy of 248 notes, 799 reviews and 248 FSRS memory
  states**, discarded at load time by a unique constraint that exists for the
  bot's benefit and was wrong for an imported collection (§2.1). ~19% of the
  notes, ~17% of the history. **Fixed 2026-09-18** (§6.3): the constraint is
  rescoped and live, and the recovery data is loadable by a maintainer-run
  script (`migration/load_recovery.py`) — the load itself hadn't run as of this
  writing.
- **There was no way to get data back out of this app.** §2.3 of DESIGN.md
  promises an `.apkg` escape hatch "kept forever". That promise was false (§2.2)
  — **fixed 2026-09-18** (§6.2, Phase 0.1): `migration/export_apkg.py` now
  writes a real, verified `.apkg` from the live tables.
- The 245-twin-pairs and one-vs-two-collection questions are **resolved** (§6):
  keep both twins, one collection, all of it Tim's — the whole `Vika` side of
  this was never on Anki to begin with.
- Those two facts, not feature gaps, are why the answer to "can we switch today"
  is no.
- The fix order is deliberate: **build the way out before walking further in.**
  Phase 0 is the escape hatch. Nothing irreversible happens until it exists.
- Once the recovery load actually runs, everything else is done: all five
  fidelity gaps (§3.1-3.5, including 4.3's per-deck-vs-per-collection daily
  limit decision) and all four of Phase 5's parity features are complete as of
  2026-09-18. Phase 6 cutover is what's left, and it depends on the maintainer
  running Phase 0.2/0.3/3.2 first.

---

## 1. Where things actually stand

Measured 2026-09-18 against the live project and `migration/`'s own output from
the 2026-09-16 run.

### 1.1 Deployed

| Piece | State |
|---|---|
| `sync` | v12, byte-verified against `main` |
| `scan` | v6, byte-verified against `main` |
| `pronounce` | v7 |
| `app` | v5 — **dead**, `web/` moved to GitHub Pages; still deployed |
| `web/` | GitHub Pages, serving current `main` |
| `telegram-bot` | v124 (capybara-bot; `/study` + `/syncanki` live) |

### 1.2 In the database

| | Count |
|---|---|
| `anki_notes` total | 1,050 |
| — `source = 'anki-import'` | 1,037 |
| — `source = 'bot'` | 13 |
| — `source = 'scan'` | 0 |
| notes with a spelling card | 241 |
| `anki_card_state` | 1,281 (241 spelling) |
| `anki_reviews` | 3,922 (1,192 spelling) |
| `anki_scheduler_config` | 2 |

Review history spans 2026-06-10 → 2026-09-17. **3,789 of those reviews were
imported; 133 were made in this app**, by both people, starting 2026-09-16.

RLS is enabled on all four `anki_*` tables with **zero policies** — deny-all for
the anon key, service-role only. That is the right posture, and it is also why the
original loader can no longer run (§2.4).

### 1.3 What the export actually contained

`migration/`'s output from the real collection:

| | Export | Loaded | Gap |
|---|---|---|---|
| Notes | 1,285 | 1,037 | **248** |
| — vocabulary | 1,094 | 847 | 247 |
| — pronunciation | 191 | 190 | 1 |
| `card_state` rows | 1,529 | 1,281 | **248** |
| Reviews | 4,588 | 3,789 | **799** |

The migration CLI itself is **not** the problem — it read the collection
correctly, including `card_kind` (D17) and pronunciation notes (D18). Note that
this contradicts `DESIGN.md` §7.5 finding 5 and §9 step 4, both of which still say
the CLI doesn't implement those and that the migration hasn't run. Both are stale;
see §8.

---

## 2. What blocks a full migration

### 2.1 🟢 248 notes and 799 reviews exist only on the phone — fixed 2026-09-18, §6.3

`anki_notes` carries:

```sql
ALTER TABLE anki_notes
  ADD CONSTRAINT anki_notes_lemma_pos_language_key
  UNIQUE (lemma, part_of_speech, language);
```

That constraint was added (`20260916100000_anki_notes_dedup_key.sql`) for a good
reason that has nothing to do with Anki: `vocabulary` has the same key, and
without it the bot would mint a fresh flashcard every time a common word got
annotated again.

It is the wrong key for an imported collection. Anki's note identity is the
**GUID**, and the real collection contains **245 pairs of notes sharing one
`(lemma, part_of_speech, language)`** — a plain `Capybara` note plus its
`Capybara+` revision, the pair `DESIGN.md` §7.5 finding 3 already documented as
two note-type names carrying one schema.

The loader could not fit both under the key, so it ranked each pair (most reviews,
then most recent, then `has_spelling`) and dropped the loser. Measured:

| | |
|---|---|
| Collision groups | 245 |
| — **both twins independently reviewed** | **242** |
| — only one reviewed | 0 |
| — neither reviewed | 3 |
| Notes discarded | 248 |
| Reviews discarded | **799** |
| FSRS memory states discarded | 248 |
| Discarded notes that had a spelling card | 3 |

**242 of 245 is the number that matters.** These are not abandoned duplicates from
a botched sync — they are cards that have both been studied, repeatedly, for
months. Whatever their origin, the collection's real shape is two independently
scheduled cards per word, and Anki has been scheduling them that way.

The loader's own docstring says all of this out loud. It was an honest trade for a
**parallel run** (D15), where AnkiDroid still held everything. It is disqualifying
for a **cutover**, where nothing else will.

### 2.2 🟢 There is no escape hatch — fixed 2026-09-18, §6.2

`DESIGN.md` §2.3, "Kept forever":

> **`.apkg` export stays.** It costs nothing — it is already written and tested —
> and it is both the backup format and the escape hatch. As long as a current
> collection can be exported back into real Anki, this project is never a bet that
> cannot be walked back.

This was false for the collection this app owns, as of when this section was
first written:

- The bot's `/export` builds its CSV from `flashcards` — capybara-bot's own table.
  It has never read `anki_notes`.
- The `.apkg` writer lives in `ukrainian-anki-scanner`, and is fed by that repo's
  own pipeline, not by this database.
- Nothing in `capybara-anki` wrote a file of any kind. There was no `/export`, no
  backup job, no dump.

So the escape hatch existed for the *bot's* word list and not for the
**migrated collection with three months of scheduling state in it**.
Uninstalling AnkiDroid before fixing this would have converted a reversible
bet into an irreversible one — exactly what §2.3 was written to prevent.
**Fixed** by Phase 0.1: `migration/export_apkg.py` now writes a real,
verified `.apkg` straight from the live `anki_*` tables.

### 2.3 🟡 The review log has one author

Every one of the 3,789 imported reviews is attributed to a single user — the
loader hardcoded one id, because an AnkiDroid export is per-installation and the
CLI takes a single `--user`. The other person has **15 reviews**, all made in this
app since 2026-09-16.

Two possibilities, and they need different work:

- **They share one collection.** Then the attribution is a fiction but a harmless
  one for scheduling (`card_state` is per card, per D22) — though `/stats` will
  report one person's streak and success rate as if it were the whole household's.
- **There are two installations.** Then a second collection has never been
  migrated at all, and its history and memory state are still only on that phone.

This is a question, not a finding — see §6.

### 2.4 🟡 The cutover window is already contaminated

- Last **imported** review: **2026-09-12**
- First **in-app** review: **2026-09-16**
- AnkiDroid has presumably kept accumulating reviews the whole time

So a fresh export no longer replaces the database — it has to **merge** with it,
on cards that now have history from both sides. `scratch/load_to_postgres.py`
cannot do this:

- It is insert-only; re-running duplicates rather than reconciling
- It keys notes on the lemma triple, not the GUID
- It writes with the anon key, which RLS now correctly refuses

It was explicitly a one-off ("Run once, by hand"). It did its job. It is not the
tool for the cutover.

---

## 3. Fidelity gaps — "does it still feel the same"

`DESIGN.md` §12 names "scheduling feels subtly wrong after the switch" as a Medium
risk, mitigated by porting all five config values. All five *are* ported. These
are the gaps that survived anyway.

### 3.1 🟢 The two apps run different FSRS versions — fixed 2026-09-18

The collection stores its parameter vector under the key **`fsrsParams6`** —
FSRS-6, 21 weights. This repo pinned **`ts-fsrs@4.7.1`**, whose default vector
was **19 weights** — FSRS-5. Verified directly rather than inferred from the
version string.

This was softened by something §7.3 already found: the vector is **empty** —
FSRS is on but Optimize has never been run — so *both* sides ran built-in
defaults rather than personalized weights. But they were different defaults
from different algorithm generations, so intervals diverged systematically
rather than randomly.

**Fixed:** bumped to `ts-fsrs@^5.4` (current stable — no beta needed).
Verified directly that its default weight vector is genuinely 21 values and
every API this codebase uses is unchanged.

### 3.2 🟢 `learning_steps` is migrated, stored, and never used — fixed 2026-09-18

`learning_steps` is read from the collection, written to `anki_scheduler_config`,
mapped through `SchedulerConfigRow`, carried into `PostgresStore` — and was
consumed by nothing. No scheduling code read it.

That behaviour was nonetheless correct, by coincidence: ts-fsrs's own defaults
for a new card were Again 1m / Hard 5m / Good 10m, and the collection's
configured steps are `[1, 10]`. Verified directly.

**Fixed:** the ts-fsrs 5.x upgrade (§3.1) added a real per-card (re)learning-step
counter and a first-class `learning_steps` config API, so wiring this up became
the natural extension of that upgrade rather than a separate decision. Now
end to end: `FsrsCardState.learningStep` round-trips through `replay.ts`
(required to correctly resume a card mid-steps), a new
`anki_card_state.learning_step` column carries it through Postgres, and
`FsrsSchedulerParams.learningSteps` distinguishes `null` (never configured →
ts-fsrs's own default) from a real `[]` (Anki's own "FSRS manages timing"
convention).

### 3.3 🟢 Daily limits were per-deck, not per-collection — fixed 2026-09-18

`getDailyCounts` used to scope each deck's allowance separately, so five decks
each got 40 new / 200 review. Anki gives the collection 40. That was harmless
while the app was a supplement; at full volume it was a 5× difference in how
much work a day asks for. **Fixed:** `getDailyCounts` no longer takes a `deck`
argument at all — one collection-wide count, shared by every deck's row and
every deck's queue. See §6.9.

### 3.4 🟢 The two people have different day boundaries — fixed 2026-09-18

`rollover_hour` is 4 for both, but one `time_zone` was `America/New_York` and the
other was **NULL**, which `day.ts` treats as UTC. So one person's study day
rolled over at 4am local and the other's at midnight local. **Fixed:** Vika's
`time_zone` is now `Europe/Kyiv`, one `UPDATE`.

### 3.5 🟢 `20260917100000_leech_settings.sql` is unapplied — fixed 2026-09-18

Behaviour was correct either way — `schedulerConfigFromRow` falls back to
Anki's own defaults when the columns are absent, exactly as designed.
**Applied live** so the repo and the database stop disagreeing.

---

## 4. Parity gaps — the "uninstall it" bar

None of these block a *cutover*; they decide whether the app is pleasant to live
in afterwards.

| Gap | Notes |
|---|---|
| **No bury** 🟢 fixed 2026-09-18 | D12 promised "suspend / bury / delete". Suspend and delete existed; bury was the missing third. Now built: manual bury/unbury (`POST /sync/bury`) plus Anki's automatic "bury siblings" — answering one of a `Capybara+` note's two cards (D17) buries the other until the study day rolls over, no unbury step needed. Stored as `anki_card_state.buried_on`, an `ankiDayKey` (day.ts), not a boolean or an expiry instant — see `src/review/mutations.ts`'s `buildBuryMutation`/`SiblingBury`. |
| **No way to add a card in the app** 🟢 fixed 2026-09-18 | `createNote` was reachable only from `/scan`. Now also `POST /sync/note` (`handlers.ts`'s `addCard`) and a ➕ screen in the reviewer itself — deck picks itself from language, same convention `/scan` already used. `source: 'app'`, a new fourth provenance value distinct from `'scan'`/`'bot'` (schema migration, `anki_notes_source_check` widened). |
| **No settings screen** 🟢 fixed 2026-09-18 | Daily limits, retention, rollover, timezone, leech threshold were all SQL-only. Now a ⚙️ screen next to ➕: `GET`/`POST /sync/settings` (`handlers.ts`'s `getSettings`/`updateSettings`), validated the same edit-in-place way as a note (`mutations.ts`'s `validateSettingsEdit`). Deliberately excludes `fsrsParams`/`maxInterval`/`learningSteps` — §4's gap never asked for those to become editable, and nothing about them changed. |
| **No audio offline** 🟢 fixed 2026-09-18 | `sw.js` caches the shell only; pronunciation cards needed the network. Now a second cache (`capybara-anki-audio-v1`): `app.js` asks `GET /sync/audio-manifest` once per page load and hands the URL list to the service worker, which fetches and caches whatever it doesn't already have — cheap on every repeat load, since the manifest is the same list far more often than not. Cache-first on match, straight to the network otherwise. **This has nothing to cache yet** — Phase 0.3 (uploading the real audio to Storage) hasn't been run against production, so every one of the 190 pronunciation notes' `audio_url` is still `NULL` live; the manifest returns `[]` until a maintainer runs it, at which point this starts working with no further change. |

That last one closes `DESIGN.md` §11 open question 1, which asked for a size
estimate before deciding a caching strategy. Measured on the real export: **190
files, 14.3 MB total, 77 KB average.** That is small enough that the question
answers itself — cache all of it, unconditionally.

---

## 5. The plan

Sequenced so that **the way out is built before we walk further in.**

### Phase 0 — Safety net (blocks everything)

| | Work |
|---|---|
| 0.1 | **`/export` → `.apkg` from `anki_notes`. Done, 2026-09-18.** `migration/apkg_writer.py` builds a real Anki collection via the `anki` library (D7's reasoning, extended to writing) and exports it through Anki's own `export_anki_package`; `migration/export_apkg.py` is the maintainer-run CLI that fetches the four tables from Postgres and calls it. This is §2.2's promise, made true — see §7. |
| 0.2 | **Scheduled backup** of the four `anki_*` tables to Storage as JSON. Still open. Cheap, and independent of 0.1 being perfect. |
| 0.3 | **Upload the pronunciation audio** — `migration/upload_pronunciation_audio.py`, maintainer-run (service-role key). Still open — needs the key. 190 notes currently have `audio_url` NULL and nothing to shadow. **Fixed 2026-09-19, before it ran even once:** the tool only worked against the older, plain export shape; a fresh re-export of the same collection uses Anki's newer container format end to end (see §6.10) and would have failed outright, or silently uploaded unplayable files, if run as it stood. |

**Gate: passed.** See §7 for the verification this rests on — a full-scale
round trip through the real 2026-09-18 export, byte-for-byte, not a synthetic
stand-in.

### Phase 1 — Make a faithful import representable — done, 2026-09-18

| | Work |
|---|---|
| 1.1 | **Rescope the unique constraint. Done, live.** `20260918120000_scope_dedup_key_to_captured_notes.sql` drops `anki_notes_lemma_pos_language_key` and replaces it with a partial unique index `WHERE source <> 'anki-import'` — bot and scan captures still dedupe against each other, imported twins coexist. Verified against live data before applying: 0 collisions among the 13 existing non-import rows, so nothing needed cleaning up first. |
| 1.2 | **Give the bot an explicit pre-check.** Still open — tracked as follow-up work in `capybara-bot`, not this repo. `/learn` currently relies on the (now-rescoped) constraint; it needs a real "is this word already a captured note?" query instead. |

### Phase 2/3 — Recover the lost data — loader done, 2026-09-18; load not yet run

The general-purpose "rewrite the loader as a merge" tool originally scoped here
turned out to be more than the actual problem needed. `cli.py` already keys
notes on `anki_guid` (via `note_uuid`, deterministic — the same GUID always
produces the same id) and already derives review ids deterministically from the
Anki revlog id (§7.2), so **re-running the existing CLI against a fresh export is
already idempotent** — no new merge logic required for that part.

What was actually missing was a *loader*: something to get `cli.py`'s JSON
output into Postgres without silently dropping or overwriting anything. That's
`migration/load_recovery.py` — maintainer-run (service-role key, same reasoning
as `upload_pronunciation_audio.py`), and it satisfies every property this phase
asked for:

- **Never drops a row** — every row in the export is sent
- **Never regresses `card_state` or reviews** — loads with `Prefer:
  resolution=ignore-duplicates`, so any row already in the table (including
  everything reviewed in-app since 2026-09-16) is left untouched, never
  overwritten by the export
- **Service role**, not the anon key
- **`--dry-run`** reports exact row counts before anything is sent

| | Work |
|---|---|
| 3.1 | Fresh full-collection export. **Done** — the 2026-09-18 colpkg, re-run through `cli.py`, sitting at `scratch/recovery/*.json` (1287 notes, 1531 card_states, 4615 reviews). |
| 3.2 | Load it. **Not yet run** — needs the maintainer's service-role key: `python -m migration.load_recovery scratch/recovery --user-id tim=<real UUID>`. As of this writing the live tables are partially loaded (1053/1287 notes, 1281/1531 card_states, 3922/4615 reviews) from manual recovery batches applied before this tool existed; `ignore-duplicates` makes re-running the loader safe regardless of that partial state. |
| 3.3 | Reconcile the 2026-09-12 → cutover window. **Already satisfied by construction** — every in-app review since 2026-09-16 has an id `cli.py` cannot reproduce from the Anki export, so `ignore-duplicates` keeps them automatically; there is no separate reconciliation step to write. |
| 3.4 | **Verify by replay.** Still open, once 3.2 runs: for a sample of cards, fold the merged log and assert the result matches what Anki itself reports. |

### Phase 4 — Fidelity — done, 2026-09-18

| | Work |
|---|---|
| 4.1 | Upgrade to an FSRS-6-capable scheduler. **Done** — `ts-fsrs@^5.4`, verified 21-weight default vector. |
| 4.2 | Wire up or delete `learning_steps`. **Done** — wired up (§3.2); the ts-fsrs upgrade made this the natural extension of 4.1, not a separate change. |
| 4.3 | Decide per-deck vs per-collection daily limits. **Done, 2026-09-18 — per-collection, matching Anki.** See §3.3 and §6.9. |
| 4.4 | Set the missing timezone. **Done** — Vika's `time_zone` is now `Europe/Kyiv`. |
| 4.5 | Apply the leech migration. **Done**, applied live. |

### Phase 5 — Parity

| | Work |
|---|---|
| 5.1 | Bury. **Done, 2026-09-18** — manual bury/unbury plus automatic bury-siblings (D17). See §4's table and §6.5. |
| 5.2 | Add-a-card screen. **Done, 2026-09-18.** See §4's table and §6.6. |
| 5.3 | Settings screen. **Done, 2026-09-18.** See §4's table and §6.7. |
| 5.4 | Cache all audio in the service worker. **Done, 2026-09-18.** See §4's table and §6.8. |

### Phase 6 — Cutover

| | Work |
|---|---|
| 6.1 | **Freeze AnkiDroid.** Stop reviewing there. Do not uninstall. |
| 6.2 | Final export + merge |
| 6.3 | **One week app-only**, with a reconciliation report |
| 6.4 | Archive the final `.apkg` off-device |
| 6.5 | Uninstall — and even then, keep the archive. |

---

## 6. Decisions

Resolved 2026-09-18.

**1. The 245 twin pairs — keep both, or merge?** **Keep both** through the
migration, per the recommendation above — merging at import would replay FSRS
over a history that was never one continuous card. A merge tool inside the app,
later, stays available precisely because the review log is append-only.

**2. One collection or two?** **One.** Every review not made in this app is
Tim's — confirmed. Vika has an iPhone with no Anki installation at all; her 15
in-app reviews (§1.2) are the entirety of her history, nothing predates them.
This removes half of Phase 3's scope outright: there is no second collection to
migrate, and no attribution question to resolve — "all of it is Tim's" was
already true, not a simplifying assumption.

**3. How strict is "fully migrating"?** **Full uninstall is the goal.** All of
Phases 0–6 apply; Phase 5's parity work is not being skipped.

### 6.1 A second export, and what it changed

A fresh export arrived 2026-09-18 (`Capybara-20260918062636.apkg`, plus a
redundant `Capybara::Pronunciation`-only export confirmed to be a strict
191-note subset of the full one — every one of its notes, none skipped, already
present in the full export). Both are **deck packages** (plain `collection.anki2`/
`collection.anki21`, no zstd `collection.anki21b` container) rather than the
full-collection export `migration/README.md` asks for — worth naming because it
could have meant missing scheduler config (§7.3's five settings live on deck
options, not the collection as a whole). It didn't: reading it produced the
identical five values the 9/16 export had, and a genuine `.colpkg` supplied
later (§6.2, item 4) confirmed byte-for-byte that nothing was lost. Running the
deck package through the existing migration CLI against the 2026-09-16 export
it replaces:

| | 2026-09-16 | 2026-09-18 | Delta |
|---|---|---|---|
| Notes | 1,285 | 1,287 | +2 |
| `card_state` | 1,529 | 1,531 | +2 |
| Reviews | 4,588 | 4,615 | +27 |

**The new export is a clean superset of the old one** — every Anki-native id
from 2026-09-16 is still present in 2026-09-18 (0 missing either direction on
notes, card states, or reviews). The +27 reviews are all dated 2026-09-17; the
+2 notes are new cards added on the phone in the same window. There is no
review-log overlap to reconcile against the app's own in-app reviews from the
same dates: an Anki revlog id and this app's client-generated review id occupy
disjoint spaces by construction, so **merging the two logs is a plain union**,
not a conflict to resolve — Phase 2's "never regress `card_state`" concern
turns out to be structurally impossible to trigger, not just something the
merge tool has to guard against. This simplifies Phase 2/3 measurably: the
merge tool doesn't need conflict-resolution logic, only idempotent insertion.

### 6.2 Phase 0.1, verified

`apkg_writer.py` writes decks, notetypes, notes, cards and revlog through the
real `anki` library rather than hand-rolled SQLite — the same reasoning D7
already made for reading, extended to writing, because a hand-written schema is
exactly how the *original* migration diverged from reality (§7.5 in
`DESIGN.md`). It deliberately does not invent a second shape to write against:
decks are named `Capybara::<deck>` and a spelling card is filed under
`Capybara::Spelling` specifically because that is what `transform.py`'s
`strip_deck_prefix`/`card_kind_for` already expect on read — the writer targets
the reader's own assumptions, not a new set of its own.

Two things had to be discovered empirically rather than assumed, both now
covered by a regression test:

- **`ExportAnkiPackageOptions` needs `with_deck_configs=True`.** Without it the
  legacy exporter silently substitutes Anki's own factory defaults for every
  deck's options — caught by a test that wrote `daily_new_limit=40` and read
  back Anki's default of `20`, not a missing-value fallback of this repo's own.
- **Deck-options config lives per-deck, not in a flat collection blob** —
  confirmed directly against the installed `anki` package rather than assumed
  from the read side's own comments about it.

**Verification, not assertion:**

1. Nine unit tests build a synthetic multi-deck, multi-kind collection (both
   vocab note types, the spelling deck split, the pronunciation note type with
   embedded media, suspended cards, never-reviewed cards) and re-read it
   through `run_migration` — the exact function a real re-import would call —
   asserting field-for-field equality.
2. **The real 2026-09-18 export** (1,287 notes, 1,531 card states, 4,615
   reviews) was written out through the writer and read back through the same
   pipeline: **zero note field mismatches, zero card-state field mismatches
   (including float equality on stability/difficulty), review tuples
   identical, 0 notes skipped.** Built in 1.3 seconds; the resulting file is
   0.4 MB without media.
3. Note ids survive a round trip **without being told to** — `note_uuid` is a
   pure function of `anki_guid`, so a note this tool exports and Anki later
   re-exports unchanged gets migrated back to the exact same Postgres row id.
   This is what makes Phase 2's merge idempotent rather than merely
   deduplicated.
4. **A genuine full-collection `.colpkg`** (not a deck package — see §6.1's
   own caveat about the two `.apkg` files) arrived shortly after this section
   was first written, exported ~17 minutes after the `.apkg` §6.1 measured.
   Read structurally: identical counts (1,287 notes, 1,531 card states, 4,615
   reviews, same five scheduler settings) — nothing changed on the phone in
   that window, and more importantly, the deck-package export from earlier
   is confirmed to have carried everything a true full-collection export
   does. Round-tripped through the writer the same way: zero mismatches.

**What this does not yet verify**, honestly: nobody has opened the resulting
`.apkg` in a real Anki or AnkiDroid install and looked at it. The round trip
proves the *data* survives intact through the exact code this repo already
trusts to read a real export back in — it does not prove Anki's own importer
is happy with the file, or that the (intentionally minimal) card templates
render sensibly. That's a five-minute manual check, not a re-open of Phase 0.1,
and it's the one item in §7's checklist below still unticked.

### 6.3 Phase 1/2/3, verified

**Phase 1 (the constraint).** Before applying the rescoped index, queried the
live `anki_notes` for `source <> 'anki-import'` rows grouped by `(lemma,
part_of_speech, language)`: 13 rows, 0 groups with more than one row. A
partial index over a strict subset of what a broader constraint already
allowed cannot discover a new violation, so this was safe to apply with no
pre-cleanup — confirmed after applying, too (`pg_constraint`/`pg_indexes`
shows the old constraint gone, the new partial index present).

**Phase 2/3 (the recovery loader).** `migration/load_recovery.py` was
dry-run against the real `scratch/recovery/` export and reports the expected
counts (1287/1531/4615) with the `tim` placeholder resolving to a real
`users.id`. It has not yet been run for real — that step needs the
maintainer's service-role key.

What actually loaded the ~1,050/1,280/3,920 rows the live tables hold as of
this writing: an earlier attempt at this same recovery, done by reading each
`recovery_sql/*.sql` batch file and retyping its contents into direct SQL
calls, before `load_recovery.py` existed. That approach is called out here
rather than just quietly abandoned, because it surfaced something worth
recording: two of those manual batches produced a transcription error in
~250 rows handled that way (a mis-copied UUID, a fabricated GUID character) —
both happened to violate a database constraint and got caught immediately,
but a plausible variant (a mistyped word inside real message content) would
have inserted cleanly and corrupted the corpus with no error at all. That
risk, not just the effort, is why the remaining rows are `load_recovery.py`'s
job instead: a mechanical JSON→PostgREST load has no transcription step to
get wrong.

### 6.4 Phase 4, verified

**3.1/3.2 (FSRS-6 + learning_steps).** `npm view ts-fsrs versions` showed
5.4.2 as the latest stable release (6.0.0 only exists as a beta line) —
installed it locally and printed `generatorParameters({ w: [] }).w.length`:
21, confirming FSRS-6 defaults without needing a beta dependency. Every
export `replay.ts` imports (`createEmptyCard`, `FSRS`, `fsrs`,
`generatorParameters`, `StrategyMode`) is still present in 5.4.2.

The upgrade's stricter `Card` type (`learning_steps: number`, no longer
optional) is what surfaced 3.2 as work rather than a separate decision: ts-fsrs
5.0 added a real per-card (re)learning-step counter, so there was a right
place to plumb the already-stored `anki_scheduler_config.learning_steps`
through rather than stubbing the new required field with a constant. Checked
directly, empirically, before writing the config-plumbing code:

- `generatorParameters({ learning_steps: [] })` → a card graduates straight
  to Review on the first Good. This is Anki's own convention for "no
  short-term steps, FSRS manages timing" (its JSDoc says so explicitly), not
  a degenerate case — so a real, stored `[]` has to be passed through as-is,
  distinct from...
- `generatorParameters({})` (key omitted) → ts-fsrs's own built-in default
  (`1m, 10m`) applies. This is what a `NULL` `learning_steps` column (never
  configured) should fall back to — conflating it with a real `[]` would
  make every not-yet-migrated user look like they'd deliberately turned
  learning steps off.

One existing test broke from this upgrade, and the fix needed a real
measurement, not a type patch: `fuzz spreads cards answered together across
different days` graduated a card with two Goods and asserted the resulting
date spread under a per-card fuzz seed. Reproduced directly: under the old
FSRS-5 defaults (ts-fsrs 4.7.1) two Goods graduated to a 4-day interval;
under FSRS-6 defaults, exactly 2.0 days — landing precisely on Anki's own
"nothing under 2.5 days gets fuzzed" boundary (confirmed against
`rslib/src/scheduler/states/fuzz.rs`, the same source §5, Phase 2's fuzz
implementation was checked against). Three Goods clears it reliably
(verified: 11 days), so that's what the test now does — the interval shift
itself is real and expected under this phase, not a bug to route around.

**3.4/3.5 (timezone, leech).** Both were single, low-risk writes — a `real[]`
default-adding migration already written and reviewed, and one `UPDATE` to a
factual field — applied live and verified by reading the row back.

### 6.5 Phase 5.1 (bury), verified

Unit and integration tests (8 new, `mutations.test.ts`/`dueQueue.test.ts`/
`handlers.test.ts`) cover the pure logic — manual bury/unbury, bury-siblings
firing only for `hasSpelling` notes and leaving the sibling's own FSRS state
untouched, a buried card excluded from `selectDueQueue` however overdue, and
the bury expiring on its own at the next study-day rollover with no unbury
step. All passed before this was considered done — but `deno check` and the
unit suite both stayed green through a real bug that only running the app
caught: `web/demo-server.ts` keeps its own hand-written copy of
`sync/index.ts`'s route table (a deliberate duplication — see that file's own
docstring on why it exists independently of the real Postgres-backed
function), and the new `/sync/bury` route only ever got added to
`sync/index.ts`. Nothing in the type system connects a route string to a
handler call, so the omission compiled and every test passed, right up until
an actual browser actually clicked the actual button and got a 404. Caught by
driving `web/demo-server.ts` in headless Chromium (`run` skill): navigate
into a deck, click Bury, screenshot before and after, read `console
--errors`. Fixed by adding the same route to `demo-server.ts`, then
re-verified the same way — screenshot shows the card correctly replaced by
the next one in the queue, no console errors, only the (expected, unrelated)
failure to load Telegram's own web-app script over this sandbox's proxy.

### 6.6 Phase 5.2 (add-a-card), verified

Reused `validateNoteEdit` rather than a second set of "what makes a card
valid" rules — the same choice `importExtractedCards` (`/scan`) already
made, for the same reason (D11: edit-in-place is the one repair path
either way, so the rule has to be the one thing both writers agree on).
Three new `handlers.test.ts` cases: a valid submission lands in the
right deck for its language, English picks the English deck, an empty
lemma is rejected before it ever reaches `store.createNote`. Verified
in a real browser (same `run`-skill loop as §6.5): opened the add-card
screen, submitted empty first (confirmed the inline validation message,
not a crash), then added a real word — the deck list's Ukrainian new-count
moved from 3 to 4 in the same session, confirming the card was actually
written and immediately due, not just accepted and silently dropped.

### 6.7 Phase 5.3 (settings screen), verified

A ⚙️ screen beside ➕, reachable only from the deck list (same convention as
➕): `GET /sync/settings` loads the editable subset of `scheduler_config`,
`POST /sync/settings` writes back only the fields the person actually
changed — a diff against what was loaded, not a blind overwrite of the whole
row, the same "a patch, not a blind write" shape `saveEdit` already used for
notes. Deliberately narrow: daily limits, retention, rollover hour, timezone,
leech threshold/action — exactly what §4's gap named. `fsrsParams`/
`maxInterval`/`learningSteps` stay SQL-only; nothing asked for those to
become editable, and a mistyped weight vector is a much sharper edge than a
mistyped limit.

`validateSettingsEdit` (`mutations.ts`) is field hygiene, same spirit as
`validateNoteEdit`: rejects a retention outside `(0, 1)`, a rollover hour
outside `0-23`, an unrecognized time zone (handed to `Intl` and caught if it
throws) — but a daily limit of 0 passes, because "review nothing new today"
is a real thing to want, not a mistake to block. 16 new
`mutations.test.ts` cases cover every field's boundary; three more in
`handlers.test.ts` cover `getSettings`/`updateSettings` against
`InMemoryStore`, including that an invalid patch never reaches
`store.updateSchedulerConfig` at all.

Learned from §6.5 not to trust `deno check` and the unit suite alone for a
route that has to exist in two places: `web/demo-server.ts`'s hand-written
route table got `/sync/settings` (GET and POST) added in the same commit as
`sync/index.ts`, before running anything, rather than after a browser found
the gap a second time. Verified in a real browser anyway (`run` skill):
opened Settings, confirmed the loaded values matched the demo config,
changed the daily new limit/timezone/leech action and saved, reopened
Settings and confirmed the new values persisted (not just accepted and
forgotten), then confirmed both halves of validation — an out-of-range
rollover hour shows the inline error and does not navigate away, and
Cancel after editing a field leaves the stored value untouched. No console
errors beyond the same (expected, unrelated) Telegram script failure §6.5
already names.

### 6.8 Phase 5.4 (offline audio), verified

A second Cache Storage cache (`capybara-anki-audio-v1`), separate from the
shell's, and separately preserved on `activate` — the shell cache name gets a
version bump whenever its own contents change (`-v6` and counting), and that
`activate` handler already deletes anything that doesn't match; without
carving out the audio cache by name too, the next unrelated shell change
would have silently wiped every cached audio file. `app.js` fetches `GET
/sync/audio-manifest` once per page load (fire-and-forget — nothing in the
review flow waits on it) and posts the URL list to the service worker, which
fetches and caches whatever it doesn't already have. That "skip what's
already there" check is what makes asking on every single load cheap rather
than wasteful: the manifest is the same 190 URLs far more often than it
isn't, so a typical load after the first does zero network requests here,
not 190.

Why a manifest endpoint rather than deriving the list from `/sync/due`: due
queues are scoped to what's due *today*, and audio has to be cached before a
card is due, not after — otherwise the first time a pronunciation card comes
up offline is exactly when it has no audio yet.

Verified in a real browser (`run` skill): `web/demo-server.ts` gained a
`/demo-audio/sample.mp3` stand-in — not real audio, not from the corpus, four
zero bytes served with an `audio/mpeg` content type, existing purely to give
the demo one real same-origin file to exercise the caching pass end to end
(the demo server serves its shell and its fake API from one origin, so
Storage's actual cross-origin path — `isPronunciationAudio`'s `/storage/v1/
object/public/` match in `sw.js` — isn't reachable through it; verified by
reading, not by running, since there is nothing this sandbox can stand in for
Supabase Storage as a second real origin). After loading the demo, a script
read `caches.keys()`/`cache.keys()` directly and confirmed
`capybara-anki-audio-v1` existed with the one demo audio URL already cached,
without ever clicking into the Pronunciation deck — proving the "cache
proactively, not on first request" property the whole point of this phase.
Setting the browser context offline and re-`fetch`ing that exact URL through
the page (which goes through the service worker like any other request)
returned `200`, confirming the cache actually serves it, not just holds it.
Opened the Pronunciation deck and screenshotted the card with its `<audio>`
element present, `src` pointing at the same URL. No console errors beyond the
same (expected, unrelated) Telegram script failure §6.5 and §6.7 already
name.

**What this can't verify from here:** the real production audio is not
uploaded yet — Phase 0.3 (`migration/upload_pronunciation_audio.py`) hasn't
been run against the live project, so `/sync/audio-manifest` currently
returns `[]` there (confirmed by querying `anki_notes`: 0 of 190
pronunciation notes have a non-null `audio_url` as of this writing). This
phase's code is correct and tested independent of that — the moment 0.3 runs,
the very next page load starts caching real files with no further change
needed — but "real audio actually plays offline on the live app" is,
necessarily, unverifiable until then.

### 6.9 Phase 4.3 (per-collection daily limits), verified

Resolved: per-collection, matching Anki's own default — one shared daily
budget, not five independent ones. `Store.getDailyCounts` dropped its `deck`
parameter outright rather than keeping it as dead functionality; the
per-deck scoping it used to do lived entirely in that one method (and in
`PostgresStore`'s matching `deckByNote` lookup, now gone too) — `dueQueue.ts`'s
`categorize`/`selectDueQueue`/`summarizeDueQueue` never knew or cared which
scope produced the `counts` they were handed, so nothing there had to change
at all. `getDeckSummaries` (handlers.ts) now asks for the daily counts once,
outside its per-deck loop, and shares that one answer across every deck's row
— simpler than before, not just more correct, since the old per-deck version
asked the same "how many taken today" question once per deck for an answer
that (post-4.3) is identical every time.

Two existing tests specifically asserted the old per-deck *isolation*
("a spelling answer counts against the Spelling deck's daily limit only",
"a deck's daily new limit is independent of another deck's") — both rewritten
to assert the new per-collection *sharing* instead, rather than deleted, so
the behavior this decision actually changed stays pinned by a test either way.

Verified in a real browser (`run` skill) too, and this one caught something
worth recording: setting the demo's daily new limit to 1 and expecting every
deck to still show 1 available slot (nothing spent yet) instead showed 0
everywhere, immediately, before any review. Not a bug — `web/demo-server.ts`
seeds one review dated essentially "today" for the stats-screen demo
(`demo-review-0`, `reviewedAt: new Date(Date.now() - 0 * DAY_MS)`), inserted
directly into the store rather than through `submitReview`, so it carries no
`reviewStateAtSubmission` entry and reads as a "new" card taken today. Under
the old per-deck accounting that phantom slot only ever touched Ukrainian
(demo-3's deck); under per-collection accounting it correctly shows up
everywhere. Re-ran with the limit at 2 instead of 1 to see both states
cleanly either side of that one-slot baseline: with 1 of 2 slots already
"spent" by the phantom, every deck read 1 available; answering the one real
new card left in Ukrainian's queue (its due queue interleaves a review card
first, so the test answers up to two cards to be sure the new one is reached)
dropped every deck to 0. Screenshotted before and after. No console errors
beyond the same Telegram-script and favicon noise every other run here shows.

### 6.10 Phase 0.3's tool, fixed before its first real run

The maintainer re-exported the collection on 2026-09-19 to actually run
`upload_pronunciation_audio.py` (§0.3) — and that fresh `.apkg` uncovered three
compatibility gaps in the tool at once, none related to the service-role key
it was waiting on:

1. **The collection database.** `read_media_items` opened it with a bare
   `sqlite3.connect` and read note types from `select models from col` — the
   same JSON-blob assumption `reader.py` already disproved for the main
   migration path (its own docstring, finding 2): a modern export's note-type
   definitions live in dedicated tables, and that column is an empty string.
   Fixed by routing through `reader.open_collection` and `col.models`, the
   same as `extract.py` already does.
2. **The `media` manifest.** Not a plain `{"0": "real.mp3", ...}` JSON dict —
   zstd-compressed (like `collection.anki21b`, but with no filename suffix to
   signal that, so this is detected from the frame's own magic number
   instead), and decompresses to Anki's own `MediaEntries` protobuf message,
   not JSON. Entries carry no archive member number at all; position doesn't
   match either (checked directly against the real file). The only reliable
   link back to a member is each entry's `sha1`, computed over that member's
   *decompressed* bytes.
3. **The numbered payload files themselves.** Independently zstd-compressed,
   every one of the real file's 190 — which is what finding 2's sha1 check has
   to decompress before it can match anything, and what the actual upload step
   has to decompress too, or Storage would silently receive 190 zstd frames
   named `….mp3` that no `<audio>` element can play.

None of this was guessed: each layer was confirmed by decoding the real
uploaded file byte-for-byte (magic numbers, protobuf field numbers by hand
before finding `anki.import_export_pb2.MediaEntries` already generated in the
installed `anki` package, then sha1-matching all 190 real entries to their
members with zero mismatches) before writing the fix. `read_media_items` now
returns 191 items against that file (one more than the 190 the original
2026-09-17 export had — the corpus grew by one pronunciation note in the two
days between exports), each verified to decompress to real MPEG audio, not
inspected beyond that — the actual lemma text stays out of this repo and out
of this document, same as every other real corpus value always has.

Added test coverage for all of it — this tool had none before, since it needs
the service-role key to exercise the write half at all. `migration/tests/
fixtures.py` gained a real pronunciation-note builder and a `media_format=
"protobuf"` export mode (entries deliberately written in scrambled order
against the numbered members, so a test relying on position rather than sha1
fails loudly) alongside the existing plain-JSON mode. `deno` isn't involved —
`python -m pytest migration/tests` (98 passing, up from 91) and the CI job's
own `compileall`/`pyflakes` steps, all run locally before this was considered
done.

---

## 7. What "done" looks like

Falsifiable, so this cannot be declared finished on vibes:

1. Every note in a fresh export exists in `anki_notes`, matched by GUID. Count
   equal, zero unmatched. **Loader ready (§6.3) — not yet run for real.**
2. Every revlog entry exists in `anki_reviews`. Count equal. **Same loader,
   same status.**
3. For a sample of cards, replaying the log reproduces Anki's own reported
   interval and due date.
4. `/export` produces an `.apkg` that imports into a clean Anki install with
   scheduling intact. **Data fidelity verified (§6.2) — the manual "open it in
   real Anki" step is the one piece of this still outstanding.**
5. A week of app-only reviewing with no reconciliation drift.
6. Both people's stats reflect their own work.

---

## 8. Corrections this document implies elsewhere

Not made here — flagged so they are not re-discovered:

- **`DESIGN.md` §7.5 finding 5** says the migration CLI does not implement
  `card_kind` and calls it "a real, currently-live bug". It was implemented; the
  2026-09-16 output carries `card_kind` on every `card_state` and review row.
- **`DESIGN.md` §9 step 4** ("Real migration, run for real") is marked blocked. It
  ran on 2026-09-16 — partially, per §2.1.
- **`README.md`** still says `sync`/`pronounce` are "not deployed yet". Both are
  deployed and verified.
- **`DESIGN.md` §11 open question 1** (audio caching) is answerable now — 14.3 MB,
  see §4.

---

## Appendix — how to re-measure any of this

Nothing above is a recollection; all of it is reproducible.

**Live counts** — the queries are plain aggregates over `anki_notes`,
`anki_card_state`, `anki_reviews`, `anki_scheduler_config`, grouped by
`source`, `deck`, `kind` and `card_kind`.

**The 248** — group `scratch/migration-output/notes.json` by
`(lemma, part_of_speech, language)`; every group of size > 1 loses all but one
member to the unique constraint. Cross-check against `anki_reviews` grouped by
`note_id` to see how many of each pair were independently reviewed.

**FSRS defaults** — `generatorParameters({ w: [] })` from `ts-fsrs` and read
`.w.length`; 19 means FSRS-5. Schedule a `createEmptyCard` against each of the
four ratings to see the learning intervals it actually produces.

**Audio size** — the media files in the `.colpkg` are the numerically-named
entries; sum their sizes.

**Never commit an export, and never quote its contents.** Structural facts —
counts, field names, deck names, timestamps — are what this document is built
from, and they are all it should ever contain. The repo is public.
