# `migration/` — read an Anki collection export, report what's in it

This is step 0 of `docs/DESIGN.md`'s build order (§9): a local, read-only tool that
answers one question before anything else gets built — **can this collection actually
be read, and does it carry the FSRS memory state and scheduler config the switch
depends on feeling like nothing changed (§7.3)?**

**Verified against a real AnkiDroid export, 2026-09-15: yes.** 1094 vocabulary notes,
4504 reviews, three months of history, read cleanly. See `docs/DESIGN.md` §7.5 for
the five real gaps between the original design and the actual file that this run
found and fixed — nothing here is theoretical anymore.

It never writes to Postgres, and it never will — see `__init__.py`. It emits plain
JSON files under `--out` and prints a human-readable report. The real migration, once
this shape is trusted, is a different (later) piece of work.

## Install

```bash
pip install -r migration/requirements.txt
```

Two real dependencies: `zstandard`, for decompressing `collection.anki21b` — modern
Anki exports compress the collection database (see `reader.py`'s docstring) — and
`anki`, the actual Anki library. That second one is heavier than a typical CLI
dependency, and it's there on purpose: a real collection's deck options are a
genuine protobuf message, not JSON, and Anki's own library is the one thing
guaranteed not to drift from Anki's own schema as it keeps changing. See
`reader.py`'s docstring for the full story. This stays fine because `migration/`
never becomes a hosted service (D7) — the dependency costs nothing in production
because there is no production copy of this code.

## Getting an export off the phone

**Get a full collection export, not a deck package.** A `.apkg` deck export does not
carry your FSRS parameters, desired retention, learning steps, or daily limits — only
a full collection export does, and those five settings are what §7.3 needs.

In AnkiDroid: deck list → overflow menu (⋮) → **Export collection**. If it offers
checkboxes: **include scheduling, exclude media** — media is the bulk of the file and
answers none of the questions this tool asks. Wording varies by AnkiDroid version; if
what you see doesn't match, that's fine, just try the export and let this tool's error
message (if any) say what's actually in the file.

**Never commit the export.** `.gitignore` at the repo root blocks the obvious
extensions, and `scratch/` (this tool's default output directory) is ignored
wholesale. Work with it from `scratch/` or anywhere outside the repo.

## Run it

```bash
python -m migration path/to/export.colpkg --user tim
```

Prints a report to stdout and writes `notes.json`, `card_state.json`, `reviews.json`,
`scheduler_config.json`, and `warnings.txt` to `scratch/migration-output/` (override
with `--out`).

`--user` identifies whose export this is (a display name is fine, e.g. `tim` or
`vika`) — it becomes `reviews.user_id` and `card_state.last_user_id`. AnkiDroid exports
are per-installation, so this is run once per person, from their own phone.

## Reading the report

The report is the point — read it before trusting the JSON:

- **`with FSRS state: N / M`** — if this is well below the card count, FSRS memory
  state isn't where `config.py`/`transform.py` expect it, and the switch would not
  feel like nothing changed (§7.3). Check `warnings.txt` for which cards and why. On
  the real collection this read 1034/1094 — the remainder are new/unreviewed cards,
  which is expected, not a gap.
- **`scheduler config` block** — each of the five settings shows *which key* supplied
  it, or `NOT FOUND`. `NOT FOUND` doesn't mean the setting doesn't exist in the
  collection — it means Anki's internal key name for it doesn't match what this tool
  currently looks for (see `config.py`'s docstring). If this fires on a future
  export, it means Anki renamed something again since 2026-09-15, not that the whole
  approach is broken — `config.py`'s candidate-key list is exactly the thing to
  extend.
- **An empty `fsrs_params` list** is a real, meaningful value on the real collection
  — Anki's convention for "FSRS is on, but Optimize has never been run," not a
  missing key. The report says so; don't read it as a failure.
- **`warnings.txt`** — every place a value was skipped or guessed, in plain language,
  with enough detail (a note id, a card id, a key name) to go looking. On the real
  export, all 449 warnings break down as 204 pronunciation-practice notes correctly
  excluded, 244 "this note has two cards" notices (a real feature of the collection,
  see `docs/DESIGN.md` §7.5 finding 5, not a bug), and one FSRS-defaults notice.

## Tests

```bash
pip install -r migration/requirements-dev.txt
python -m pytest migration/tests -v
```

Every test runs against a synthetic collection — never a real export. The fixture
builder (`migration/tests/fixtures.py`) builds those collections with the real `anki`
library rather than hand-written SQL, precisely because hand-written SQL is exactly
what let the original schema assumptions drift from reality undetected (see
`docs/DESIGN.md` §7.5) — a fixture built by the same library this package reads with
can't independently drift from what that library actually produces.

The suite covers both container formats `reader.py` has to handle (plain and
zstd-compressed, with the real no-content-size-header framing), the note-type
recognition that stands between a real card and a silently mis-mapped or
silently-dropped one (by field signature, not name — two real note-type names share
one schema), idempotency across repeated runs (§7.2 — migration is re-run at least
twice, per D15), the "Anki renamed a config key" case, and the "one config key is an
untouched empty placeholder while another candidate holds real data" case that a real
export actually hit during this verification.

## Exporting back out — `export_apkg.py`

The escape hatch `docs/DESIGN.md` §2.3 promises: reads the live `anki_notes` /
`anki_card_state` / `anki_reviews` / `anki_scheduler_config` tables and writes a
real `.apkg` via `apkg_writer.py`, using the `anki` library rather than
hand-rolled SQLite — the same D7 reasoning this package's read side already
rests on, extended to writing. See `docs/MIGRATION.md` §6.2 for what's been
verified so far (a full-scale round trip against a real export, byte-for-byte)
and what hasn't yet (nobody has opened the result in a real Anki install).

```bash
export SUPABASE_URL=https://<ref>.supabase.co
export SUPABASE_SERVICE_ROLE_KEY=<service role key>
python -m migration.export_apkg --out backup.apkg
```

`--dry-run` reports row counts and writes nothing. `--user-id` picks whose
`scheduler_config` supplies the five settings §7.3 cares about (default:
whoever has the most reviews). `--no-audio` skips downloading pronunciation
recordings if you just want the text and scheduling state quickly.

Needs the service-role key, same reason as `upload_pronunciation_audio.py` —
it lives on the maintainer's machine and nowhere else.
