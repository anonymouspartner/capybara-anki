"""Migration CLI — reads an Anki collection export and reports/emits what is in it.

This is step 0 of docs/DESIGN.md's build order (§9): a local tool, run by hand a
handful of times, that never touches Postgres and never gets deployed (see D7 — Python
stays local, everything hosted is TypeScript). Its whole job is to answer one question
before any other code gets written: can this collection actually be read, and does it
carry what §7.3 needs (FSRS memory state + scheduler config) to make the switch feel
like nothing changed?

Two hard boundaries, both from the repo's ground rules and from §7.4 of the design
doc, hold for the core read pipeline — `reader.py`, `extract.py`, `transform.py`,
`config.py`, `cli.py`, `schema.py`:
  - Read-only. This core never writes to Postgres.
  - No Supabase changes from the core. It never calls out to a live project; it
    only ever reads a `.apkg`/`.colpkg` file on disk.

Three separate, explicitly maintainer-run tools live alongside that core and do NOT
share this boundary, on purpose — `upload_pronunciation_audio.py` (reads a real
export, writes to Supabase Storage and `anki_notes.audio_url`), `export_apkg.py`
(reads the live `anki_*` tables, writes a `.apkg` file), and `load_recovery.py`
(reads this core's own JSON output, writes whatever the live `anki_*` tables are
still missing — the one place data flows from an export INTO Postgres). All three
require the service-role key on the maintainer's own machine and are run by hand,
the same "local tool, not a hosted service" reasoning (D7) that makes the core
package safe to depend on `anki` in the first place — see `docs/MIGRATION.md`
§6.2 for what `export_apkg.py` is for and §2.1 for what `load_recovery.py` is for.
"""
