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

Five separate tools live alongside that core and do NOT share this boundary, on
purpose — `upload_pronunciation_audio.py` (reads a real export, writes to
Supabase Storage and `anki_notes.audio_url`), `export_apkg.py` (reads the live
`anki_*` tables, writes a `.apkg` file), `load_recovery.py` (reads this core's
own JSON output, writes whatever the live `anki_*` tables are still missing —
the one place data flows from an export INTO Postgres), and
`backup_tables.py` (reads the live `anki_*` tables, writes a JSON snapshot to
Storage), and `reconcile.py` (reads the live tables and a snapshot, writes
nothing — Phase 6.3's reconciliation report). See `docs/MIGRATION.md` §6.2 for what `export_apkg.py` is for and
§2.1 for what `load_recovery.py` is for.

The first three require the service-role key on the maintainer's own machine
and are run by hand, the same "local tool, not a hosted service" reasoning
(D7) that makes the core package safe to depend on `anki` in the first place.
`backup_tables.py` breaks that pattern on purpose: it's meant to run
unattended, on a schedule, from `.github/workflows/backup.yml` — the
service-role key comes from a GitHub Actions secret there, not a person's own
shell. It stays dependency-free (no `anki`, no `zstandard`) precisely because
it's the one tool in this package meant to run without a human watching.
`reconcile.py` also runs from Actions (`.github/workflows/reconcile.yml`, by
hand) and is stdlib-only for the same reason; it is read-only.
"""
