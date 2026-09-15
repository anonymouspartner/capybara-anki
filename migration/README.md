# `migration/` — read an Anki collection export, report what's in it

This is step 0 of `docs/DESIGN.md`'s build order (§9): a local, read-only tool that
answers one question before anything else gets built — **can this collection actually
be read, and does it carry the FSRS memory state and scheduler config the switch
depends on feeling like nothing changed (§7.3)?**

It never writes to Postgres, and it never will — see `__init__.py`. It emits plain
JSON files under `--out` and prints a human-readable report. The real migration, once
this shape is trusted, is a different (later) piece of work.

## Install

```bash
pip install -r migration/requirements.txt
```

The only real dependency is `zstandard`, for decompressing `collection.anki21b` —
modern Anki exports compress the collection database; see `reader.py`'s docstring.
Everything else is Python stdlib.

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
  feel like nothing changed (§7.3). Check `warnings.txt` for which cards and why.
- **`scheduler config` block** — each of the five settings shows *which key* supplied
  it, or `NOT FOUND`. `NOT FOUND` doesn't mean the setting doesn't exist in the
  collection — it means Anki's internal key name for it doesn't match what this tool
  currently looks for (see `config.py`'s docstring). That's expected to need a fix
  once a real export is in hand; it is not a sign the whole approach is broken.
- **`warnings.txt`** — every place a value was skipped or guessed, in plain language,
  with enough detail (a note id, a card id, a key name) to go looking.

If the FSRS state and scheduler config both come through clean, the hardest unknown in
`docs/DESIGN.md` (§7.1) is retired and step 1 (schema + review-log replay) can start.
If they don't, `config.py` and `transform.py` are the two files to fix — both were
written defensively for exactly this: report the mismatch loudly, guess nothing.

## Tests

```bash
pip install -r migration/requirements-dev.txt
python -m pytest migration/tests -v
```

Every test runs against a synthetic collection built in `migration/tests/fixtures.py`
— never a real export. The suite covers both container formats reader.py has to
handle (plain and zstd-compressed), the note-type/field-order validation that stands
between a real card and a silently mis-mapped one, idempotency across repeated runs
(§7.2 — migration is re-run at least twice, per D15), and the "Anki renamed a config
key" case that `config.py`'s candidate-key search exists for.
