# Migration — retiring AnkiDroid

**Status: Phase 0.1 done, gate passed. Written 2026-09-18, against the live
database and two real exports — every number below was measured, not
estimated. See the Appendix for how to re-measure any of them.**

`docs/DESIGN.md` is the plan of record for *what this app is*. This document is
narrower and more urgent: it is the plan for **the day AnkiDroid gets
uninstalled**, and the list of things that are not true yet but have to be first.

---

## 0. TL;DR

- The app is live, both people are reviewing in it, and the reviewer itself is in
  good shape. That is not what stands in the way.
- **AnkiDroid currently holds the only copy of 248 notes, 799 reviews and 248 FSRS
  memory states.** They were discarded at load time by a unique constraint that
  exists for the bot's benefit and is wrong for an imported collection (§2.1).
  ~19% of the notes, ~17% of the history.
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
- Once those are fixed the remaining work is real but bounded: a merge-shaped
  loader (§5, Phase 2), one re-migration (Phase 3), four fidelity gaps (Phase 4),
  and four parity features (Phase 5).

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

### 2.1 🔴 248 notes and 799 reviews exist only on the phone

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

### 2.2 🔴 There is no escape hatch

`DESIGN.md` §2.3, "Kept forever":

> **`.apkg` export stays.** It costs nothing — it is already written and tested —
> and it is both the backup format and the escape hatch. As long as a current
> collection can be exported back into real Anki, this project is never a bet that
> cannot be walked back.

This is currently false for the collection this app owns:

- The bot's `/export` builds its CSV from `flashcards` — capybara-bot's own table.
  It has never read `anki_notes`.
- The `.apkg` writer lives in `ukrainian-anki-scanner`, and is fed by that repo's
  own pipeline, not by this database.
- Nothing in `capybara-anki` writes a file of any kind. There is no `/export`, no
  backup job, no dump.

So the escape hatch exists for the *bot's* word list and not for the **migrated
collection with three months of scheduling state in it**. Uninstalling AnkiDroid
before fixing this converts a reversible bet into an irreversible one, which is
exactly what §2.3 was written to prevent.

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

### 3.1 The two apps run different FSRS versions

The collection stores its parameter vector under the key **`fsrsParams6`** —
FSRS-6, 21 weights. This repo pins **`ts-fsrs@4.7.1`**, whose default vector is
**19 weights** — FSRS-5. Verified directly rather than inferred from the version
string.

This is softened by something §7.3 already found: the vector is **empty** — FSRS
is on but Optimize has never been run — so *both* sides are running built-in
defaults rather than personalized weights. But they are different defaults from
different algorithm generations, so intervals will diverge systematically rather
than randomly.

Not urgent, not invisible. Fixed by upgrading the scheduler (§5, Phase 4).

### 3.2 `learning_steps` is migrated, stored, and never used

`learning_steps` is read from the collection, written to `anki_scheduler_config`,
mapped through `SchedulerConfigRow`, carried into `PostgresStore` — and consumed
by nothing. No scheduling code reads it.

Today's behaviour is nonetheless correct, by coincidence: ts-fsrs's own defaults
for a new card are Again 1m / Hard 5m / Good 10m, and the collection's configured
steps are `[1, 10]`. Verified directly.

The hazard is that it *looks* configured. Changing the value changes nothing, and
the next person to read this code will reasonably assume otherwise. Either wire it
up or delete the column and say ts-fsrs owns it — the current state is the worst
of the three.

### 3.3 Daily limits are per-deck, not per-collection

`getDailyCounts` scopes each deck's allowance separately, so five decks each get
40 new / 200 review. Anki gives the collection 40. This is deliberate and
documented in `store.ts`, and it was harmless while the app was a supplement. At
full volume it is a 5× difference in how much work a day asks for.

### 3.4 The two people have different day boundaries

`rollover_hour` is 4 for both, but one `time_zone` is `America/New_York` and the
other is **NULL**, which `day.ts` treats as UTC. So one person's study day rolls
over at 4am local and the other's at midnight local. One `UPDATE`.

### 3.5 `20260917100000_leech_settings.sql` is unapplied

Behaviour is correct — `schedulerConfigFromRow` falls back to Anki's own defaults
when the columns are absent, exactly as designed. Worth applying anyway so the
repo and the database stop disagreeing.

---

## 4. Parity gaps — the "uninstall it" bar

None of these block a *cutover*; they decide whether the app is pleasant to live
in afterwards.

| Gap | Notes |
|---|---|
| **No bury** | D12 promised "suspend / bury / delete". Suspend and delete exist; bury was never built. |
| **No way to add a card in the app** | `createNote` is reachable only from `/scan`. Capture depends entirely on the bot or a photo. |
| **No settings screen** | Daily limits, retention, rollover, timezone, leech threshold are all SQL-only. |
| **No audio offline** | `sw.js` caches the shell only. Pronunciation cards need the network. |

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
| 0.3 | **Upload the pronunciation audio** — `migration/upload_pronunciation_audio.py`, maintainer-run (service-role key). Still open. 190 notes currently have `audio_url` NULL and nothing to shadow. |

**Gate: passed.** See §7 for the verification this rests on — a full-scale
round trip through the real 2026-09-18 export, byte-for-byte, not a synthetic
stand-in.

### Phase 1 — Make a faithful import representable

| | Work |
|---|---|
| 1.1 | **Rescope the unique constraint.** Drop `anki_notes_lemma_pos_language_key`; replace with a partial unique index `WHERE source <> 'anki-import'`, so bot and scan captures still dedupe against each other while imported twins coexist. If accepted this belongs in `DESIGN.md` §3 as a new decision. |
| 1.2 | **Give the bot an explicit pre-check.** `/learn` currently relies on that constraint to avoid re-adding a word you already have. Once it is scoped, the check has to be a real query — "is this word already a note, from any source?" — not a database error being swallowed. |

### Phase 2 — Rewrite the loader as a merge

Promote `scratch/load_to_postgres.py` into a tested `migration/load.py`:

- **Key notes on `anki_guid`**, cards on `(anki_guid, card_kind)` — the real
  identity, the one §7.2 already named
- **Derive review ids deterministically** from the Anki revlog id, so a re-run is
  a no-op instead of a duplicate
- **Never drop a row.** Anything unplaceable goes into a report, loudly. The
  current silent-drop behaviour is what produced §2.1.
- **Never regress `card_state`.** If the app's state is newer than the export's,
  the app wins — reviews made here since 2026-09-16 must not be rolled back
- **Service role**, not the anon key
- **`--dry-run` that prints the whole diff** before anything is written

### Phase 3 — Re-migrate for real

| | Work |
|---|---|
| 3.1 | Fresh full-collection export (see §6 on how many phones) |
| 3.2 | Dry-run → read the diff → load. Recovers the 248 notes, 799 reviews, 248 memory states |
| 3.3 | Reconcile the 2026-09-12 → cutover window: AnkiDroid's reviews merge in, the app's stay |
| 3.4 | **Verify by replay.** For a sample of cards, fold the merged log and assert the result matches what Anki itself reports. This is precisely the check §4.3's "card_state is a cache" design was built to make possible — this is the moment it earns its keep. |

### Phase 4 — Fidelity

4.1 Upgrade to an FSRS-6-capable scheduler · 4.2 Wire up or delete
`learning_steps` · 4.3 Decide per-deck vs per-collection limits · 4.4 Set the
missing timezone · 4.5 Apply the leech migration

### Phase 5 — Parity

5.1 Bury · 5.2 Add-a-card screen · 5.3 Settings screen · 5.4 Cache all audio in
the service worker

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

A fresh full-collection export arrived 2026-09-18 (`Capybara-20260918062636.apkg`,
plus a redundant `Capybara::Pronunciation`-only export confirmed to be a strict
191-note subset of the full one — every one of its notes, none skipped, already
present in the full export). Running it through the existing migration CLI
against the 2026-09-16 export it replaces:

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

**What this does not yet verify**, honestly: nobody has opened the resulting
`.apkg` in a real Anki or AnkiDroid install and looked at it. The round trip
proves the *data* survives intact through the exact code this repo already
trusts to read a real export back in — it does not prove Anki's own importer
is happy with the file, or that the (intentionally minimal) card templates
render sensibly. That's a five-minute manual check, not a re-open of Phase 0.1,
and it's the one item in §7's checklist below still unticked.

---

## 7. What "done" looks like

Falsifiable, so this cannot be declared finished on vibes:

1. Every note in a fresh export exists in `anki_notes`, matched by GUID. Count
   equal, zero unmatched.
2. Every revlog entry exists in `anki_reviews`. Count equal.
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
